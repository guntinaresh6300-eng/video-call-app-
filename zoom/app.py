import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, redirect
from flask_socketio import SocketIO, emit, join_room, leave_room
import os
import mimetypes

mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')
app = Flask(__name__)
app.config['SECRET_KEY'] = 'videocall-secret-key'
socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False)

# Track rooms and their users
rooms = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/room')
@app.route('/room/')
def room_fallback():
    return redirect('/')

@app.route('/room/<room_id>', strict_slashes=False)
def room(room_id):
    return render_template('room.html', room_id=room_id)

# ── Socket events ──────────────────────────────────────────

@socketio.on('join_room')
def handle_join(data):
    room_id = data['room']
    user_id = request.sid

    join_room(room_id)

    if room_id not in rooms:
        rooms[room_id] = []

    rooms[room_id].append(user_id)
    count = len(rooms[room_id])

    print(f"[JOIN] {user_id[:8]} joined room {room_id} | users: {count}")

    # Tell the joining user who is already in the room
    emit('room_joined', {
        'user_id': user_id,
        'peers': [p for p in rooms[room_id] if p != user_id],
        'count': count
    })

    # Notify existing users that someone new joined
    emit('peer_joined', {'peer_id': user_id}, to=room_id, skip_sid=user_id)


@socketio.on('offer')
def handle_offer(data):
    print(f"[OFFER] {request.sid[:8]} → {data['target'][:8]}")
    emit('offer', {
        'offer': data['offer'],
        'sender': request.sid
    }, to=data['target'])


@socketio.on('answer')
def handle_answer(data):
    print(f"[ANSWER] {request.sid[:8]} → {data['target'][:8]}")
    emit('answer', {
        'answer': data['answer'],
        'sender': request.sid
    }, to=data['target'])


@socketio.on('ice_candidate')
def handle_ice(data):
    emit('ice_candidate', {
        'candidate': data['candidate'],
        'sender': request.sid
    }, to=data['target'])


@socketio.on('disconnect')
def handle_disconnect():
    user_id = request.sid
    for room_id, members in list(rooms.items()):
        if user_id in members:
            members.remove(user_id)
            emit('peer_left', {'peer_id': user_id}, to=room_id)
            print(f"[LEAVE] {user_id[:8]} left room {room_id}")
            if not members:
                del rooms[room_id]
            break


@socketio.on('chat_message')
def handle_chat(data):
    room_id = data['room']
    emit('chat_message', {
        'message': data['message'],
        'sender_id': request.sid[:6],
        'is_self': False
    }, to=room_id, skip_sid=request.sid)


@socketio.on('media_state')
def handle_media_state(data):
    room_id = data['room']
    emit('peer_media_state', {
        'peer_id': request.sid,
        'video': data.get('video', True),
        'audio': data.get('audio', True)
    }, to=room_id, skip_sid=request.sid)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5006))
    print(f"\n[VideoCall] app running on http://localhost:{port}\n")
    socketio.run(app, host='0.0.0.0', port=port, debug=True)
