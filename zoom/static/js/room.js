/**
 * VideoCall - WebRTC Signaling Client
 * Handles peer connection, media, screen share, and chat
 */

// ── Config ──────────────────────────────────────────────
const ROOM_ID = window.ROOM_ID;
const ICE_CONF = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── State ────────────────────────────────────────────────
let localStream = null;
let screenStream = null;
const peerConnections = {}; // Stores RTCPeerConnections by peerId
const queuedCandidates = {}; // Stores arrays of RTCIceCandidate for peers whose remote description is not set yet
let isMuted = false;
let isCamOff = false;
let isScreenSharing = false;
let unreadChat = 0;
let chatOpen = false;

// ── DOM refs ─────────────────────────────────────────────
const localVideo = document.getElementById('local-video');
const videoArea = document.getElementById('video-area');
const waitingTile = document.getElementById('waiting-tile');
const connStatus = document.getElementById('conn-status');
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatBadge = document.getElementById('chat-badge');
const localOverlay = document.getElementById('local-overlay');

// ── Socket ───────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── Media Setup ──────────────────────────────────────────
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    console.log('[Media] Local stream started');
  } catch (err) {
    console.warn('[Media] Dual getUserMedia failed, trying audio only...', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localVideo.srcObject = localStream;
      console.log('[Media] Audio-only stream started');
      localOverlay.classList.remove('hidden');
      localOverlay.querySelector('span').textContent = 'No camera access';
      isCamOff = true;
      
      // Update UI for camera off
      const camBtn = document.getElementById('btn-cam');
      if (camBtn) {
        camBtn.querySelector('.ctrl-label').textContent = 'Start Video';
        document.getElementById('cam-icon').textContent = '🚫';
        camBtn.classList.add('cam-off');
      }
    } catch (audioErr) {
      console.warn('[Media] Audio-only getUserMedia failed:', audioErr);
      addSystemMessage('⚠️ Camera and microphone access denied. You can still join.');
      localOverlay.classList.remove('hidden');
      localOverlay.querySelector('span').textContent = 'No media access';
      isCamOff = true;
      isMuted = true;
      
      // Update button states in UI
      const camBtn = document.getElementById('btn-cam');
      if (camBtn) {
        camBtn.querySelector('.ctrl-label').textContent = 'Start Video';
        document.getElementById('cam-icon').textContent = '🚫';
        camBtn.classList.add('cam-off');
      }

      const micBtn = document.getElementById('btn-mic');
      if (micBtn) {
        micBtn.querySelector('.ctrl-label').textContent = 'Unmute';
        document.getElementById('mic-icon').textContent = '🔇';
        micBtn.classList.add('muted');
      }
    }
  }
}

// ── WebRTC ───────────────────────────────────────────────
function createPeerConnection(peerId) {
  if (peerConnections[peerId]) {
    return peerConnections[peerId];
  }
  
  console.log('[RTC] Creating peer connection to', peerId.slice(0, 8));
  
  // Create remote tile immediately so they appear in the grid
  createRemoteTile(peerId);

  const pc = new RTCPeerConnection(ICE_CONF);
  peerConnections[peerId] = pc;
  queuedCandidates[peerId] = [];

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  } else {
    // Ensure we can still receive media if we don't have our own
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  // Remote stream
  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    console.log(`[RTC] Received remote track (${e.track.kind}) from`, peerId.slice(0,8));
    if (e.streams && e.streams.length > 0) {
      showRemoteVideo(peerId, e.streams[0]);
    } else {
      remoteStream.addTrack(e.track);
      showRemoteVideo(peerId, remoteStream);
    }
    
    if (e.track.kind === 'video') {
      const overlay = document.getElementById(`remote-overlay-${peerId}`);
      overlay?.classList.add('hidden');
    }
  };

  // ICE candidates
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice_candidate', { target: peerId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[RTC] Connection state with ${peerId.slice(0,8)}:`, state);
    if (state === 'connected') {
      updateConnStatus();
      const overlay = document.getElementById(`remote-overlay-${peerId}`);
      if (overlay) {
        const span = overlay.querySelector('span');
        if (span && span.textContent === 'Connecting…') {
          span.textContent = 'Camera Off';
        }
      }
    } else if (['disconnected', 'failed', 'closed'].includes(state)) {
      removeRemoteVideo(peerId);
      updateConnStatus();
    }
  };

  return pc;
}

async function makeOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { target: peerId, offer });
  console.log('[RTC] Sent offer to', peerId.slice(0, 8));
}

async function flushIceQueue(peerId) {
  const pc = peerConnections[peerId];
  const queue = queuedCandidates[peerId];
  if (!pc || !queue) return;
  
  console.log(`[RTC] Flushing ${queue.length} queued ICE candidates for`, peerId.slice(0, 8));
  while (queue.length > 0) {
    const candidate = queue.shift();
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('[RTC] Error adding queued ICE candidate', e);
    }
  }
}

async function handleOffer(data) {
  const { offer, sender } = data;
  const pc = createPeerConnection(sender);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  await flushIceQueue(sender);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { target: sender, answer });
  console.log('[RTC] Sent answer to', sender.slice(0, 8));
}

async function handleAnswer(data) {
  const pc = peerConnections[data.sender];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    console.log('[RTC] Set remote description (answer) from', data.sender.slice(0,8));
    await flushIceQueue(data.sender);
  }
}

async function handleICE(data) {
  const peerId = data.sender;
  const pc = peerConnections[peerId];
  const candidate = new RTCIceCandidate(data.candidate);
  
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn('[RTC] ICE candidate error', e);
    }
  } else {
    if (!queuedCandidates[peerId]) {
      queuedCandidates[peerId] = [];
    }
    queuedCandidates[peerId].push(candidate);
    console.log('[RTC] Queued ICE candidate from', peerId.slice(0, 8));
  }
}

// ── Remote Video DOM ─────────────────────────────────────
function updateConnStatus() {
  const activeCount = Object.keys(peerConnections).length;
  if (activeCount > 0) {
    connStatus.textContent = `● Connected (${activeCount + 1} users)`;
    connStatus.classList.add('connected');
    waitingTile.classList.add('hidden');
  } else {
    connStatus.textContent = '● Waiting for peers…';
    connStatus.classList.remove('connected');
    waitingTile.classList.remove('hidden');
    videoArea.className = 'video-area'; // reset layout
  }
}

function updateVideoLayout() {
  const totalUsers = Object.keys(peerConnections).length + 1; // +1 for self
  videoArea.className = 'video-area'; // Reset classes
  
  if (totalUsers === 2) {
    videoArea.classList.add('two-users');
  } else if (totalUsers === 3 || totalUsers === 4) {
    videoArea.classList.add('grid-2x2');
  } else if (totalUsers >= 5) {
    videoArea.classList.add('grid-3x3');
  }
}

function createRemoteTile(peerId) {
  let tileId = `remote-tile-${peerId}`;
  let tile = document.getElementById(tileId);
  if (tile) return tile;

  waitingTile.classList.add('hidden');

  tile = document.createElement('div');
  tile.className = 'video-tile remote-tile';
  tile.id = tileId;

  const video = document.createElement('video');
  video.id = `video-${peerId}`;
  video.autoplay = true;
  video.playsinline = true;

  const label = document.createElement('div');
  label.className = 'video-label';
  label.textContent = `Participant (${peerId.slice(0,4)})`;

  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.id = `remote-overlay-${peerId}`;
  overlay.innerHTML = `
    <div class="cam-off-icon">📷</div>
    <span>Connecting…</span>
  `;

  tile.appendChild(video);
  tile.appendChild(label);
  tile.appendChild(overlay);
  videoArea.appendChild(tile);
  
  updateVideoLayout();
  updateConnStatus();
  return tile;
}

function showRemoteVideo(peerId, stream) {
  createRemoteTile(peerId);
  const video = document.getElementById(`video-${peerId}`);
  if (video && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(err => {
      console.warn('[Video] Remote play failed:', err);
    });
  }
}

function removeRemoteVideo(peerId) {
  const tile = document.getElementById(`remote-tile-${peerId}`);
  const pcExists = !!peerConnections[peerId];
  
  if (!tile && !pcExists) return; // Already cleaned up

  if (tile) tile.remove();
  
  if (peerConnections[peerId]) {
    peerConnections[peerId].close();
    delete peerConnections[peerId];
  }
  delete queuedCandidates[peerId];
  
  updateVideoLayout();
  updateConnStatus();
  addSystemMessage(`👋 Participant ${peerId.slice(0,4)} left the call.`);
}

// ── Controls ─────────────────────────────────────────────
document.getElementById('btn-mic').addEventListener('click', () => {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  const btn = document.getElementById('btn-mic');
  btn.querySelector('.ctrl-label').textContent = isMuted ? 'Unmute' : 'Mute';
  document.getElementById('mic-icon').textContent = isMuted ? '🔇' : '🎤';
  btn.classList.toggle('muted', isMuted);

  // Tell peers
  socket.emit('media_state', { room: ROOM_ID, audio: !isMuted, video: !isCamOff });
});

document.getElementById('btn-cam').addEventListener('click', () => {
  isCamOff = !isCamOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  }
  const btn = document.getElementById('btn-cam');
  btn.querySelector('.ctrl-label').textContent = isCamOff ? 'Start Video' : 'Stop Video';
  document.getElementById('cam-icon').textContent = isCamOff ? '🚫' : '📹';
  btn.classList.toggle('cam-off', isCamOff);
  localOverlay.classList.toggle('hidden', !isCamOff);

  socket.emit('media_state', { room: ROOM_ID, audio: !isMuted, video: !isCamOff });
});

document.getElementById('btn-screen').addEventListener('click', async () => {
  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      // Replace track on all peer connections
      Object.values(peerConnections).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

      localVideo.srcObject = screenStream;
      isScreenSharing = true;
      document.getElementById('btn-screen').classList.add('screen-sharing');
      document.querySelector('#btn-screen .ctrl-label').textContent = 'Stop Share';

      screenTrack.onended = () => stopScreenShare();
    } catch (e) {
      console.warn('[Screen] Share cancelled or denied', e);
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (localStream) {
    const camTrack = localStream.getVideoTracks()[0];
    Object.values(peerConnections).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
  }
  localVideo.srcObject = localStream;
  screenStream?.getTracks().forEach(t => t.stop());
  isScreenSharing = false;
  document.getElementById('btn-screen').classList.remove('screen-sharing');
  document.querySelector('#btn-screen .ctrl-label').textContent = 'Share Screen';
}

document.getElementById('btn-chat').addEventListener('click', toggleChat);
document.getElementById('btn-close-chat').addEventListener('click', toggleChat);

function toggleChat() {
  chatOpen = !chatOpen;
  chatPanel.classList.toggle('open', chatOpen);
  if (chatOpen) {
    unreadChat = 0;
    chatBadge.textContent = '0';
    chatBadge.classList.add('hidden');
    chatInput.focus();
  }
}

document.getElementById('btn-leave').addEventListener('click', () => {
  if (confirm('Leave this meeting?')) {
    localStream?.getTracks().forEach(t => t.stop());
    Object.values(peerConnections).forEach(pc => pc.close());
    window.location.href = '/';
  }
});

document.getElementById('btn-copy-room').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href);
  const btn = document.getElementById('btn-copy-room');
  btn.textContent = '✓ Link Copied!';
  setTimeout(() => btn.textContent = '🔗 Copy Link', 2000);
});

// ── Chat ─────────────────────────────────────────────────
function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat_message', { room: ROOM_ID, message: msg });
  appendChat(msg, true);
  chatInput.value = '';
}

document.getElementById('btn-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function appendChat(text, isSelf, senderId = null) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg' + (isSelf ? ' self' : '');

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = isSelf ? 'You' : `Participant (${senderId})`;

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (!isSelf && !chatOpen) {
    unreadChat++;
    chatBadge.textContent = unreadChat;
    chatBadge.classList.remove('hidden');
  }
}

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Socket Events ─────────────────────────────────────────
socket.on('connect', () => {
  console.log('[Socket] Connected, joining room', ROOM_ID);
  socket.emit('join_room', { room: ROOM_ID });
  socket.emit('media_state', { room: ROOM_ID, audio: !isMuted, video: !isCamOff });
  updateConnStatus();
});

socket.on('room_joined', (data) => {
  console.log('[Room] Joined. Peers:', data.peers);
  // Initiate offer to ALL existing peers in the room
  data.peers.forEach(peerId => {
    makeOffer(peerId);
    addSystemMessage(`👤 Connecting to existing participant ${peerId.slice(0,4)}…`);
  });
});

socket.on('peer_joined', (data) => {
  console.log('[Room] Peer joined:', data.peer_id.slice(0, 8));
  addSystemMessage(`👤 Participant ${data.peer_id.slice(0,4)} joined the room, connecting…`);
});

socket.on('offer', (data) => handleOffer(data));
socket.on('answer', (data) => handleAnswer(data));
socket.on('ice_candidate', (data) => handleICE(data));

socket.on('peer_left', (data) => {
  removeRemoteVideo(data.peer_id);
});

socket.on('chat_message', (data) => {
  appendChat(data.message, false, data.sender_id);
});

socket.on('peer_media_state', (data) => {
  const tile = document.getElementById(`remote-tile-${data.peer_id}`);
  if (!tile) return;

  // Update camera overlay
  const overlay = document.getElementById(`remote-overlay-${data.peer_id}`);
  if (overlay) {
    overlay.classList.toggle('hidden', data.video);
    const overlaySpan = overlay.querySelector('span');
    if (overlaySpan) {
      overlaySpan.textContent = 'Camera Off';
    }
  }

  // Update mic mute tag
  let muteTag = tile.querySelector('.remote-mic-off');
  if (!data.audio) {
    if (!muteTag) {
      muteTag = document.createElement('div');
      muteTag.className = 'remote-mic-off';
      muteTag.textContent = '🔇';
      tile.appendChild(muteTag);
    }
  } else {
    muteTag?.remove();
  }
});

// ── Init ──────────────────────────────────────────────────
(async () => {
  await startLocalMedia();
  addSystemMessage(`🏠 You're in room: ${ROOM_ID}`);
})();
