'use strict';

const Messaging = require.main.require('./src/messaging');
const user = require.main.require('./src/user');
const db = require.main.require('./src/database');
const sockets = require.main.require('./src/socket.io');

const plugin = {};

// Our own per-room hash of uid -> last-seen timestamp (ms).
// We keep our own copy so we can broadcast in real time, and we merge it with
// NodeBB's core read state (uid:<uid>:chat:rooms:read) so the baseline is correct
// even for rooms that existed before this plugin was installed.
function roomKey(roomId) {
	return `chat-read-receipts:room:${roomId}`;
}

plugin.init = async function () {
	const socketPlugins = require.main.require('./src/socket.io/plugins');
	socketPlugins.chatReadReceipts = {
		markSeen: markSeen,
		getRoomReadState: getRoomReadState,
	};
};

async function assertInRoom(uid, roomId) {
	if (!(parseInt(uid, 10) > 0) || !(parseInt(roomId, 10) > 0)) {
		throw new Error('[[error:invalid-data]]');
	}
	// Check real room membership directly against the membership sorted set,
	// NOT via Messaging.isUserInRoom. The latter runs the result through the
	// filter:messaging.isUserInRoom hook, which other plugins (e.g.
	// nodebb-plugin-admin-chats) override to return true for admins/managers
	// who are merely viewing the room. Honouring that override here would let a
	// lurking admin's view be recorded and broadcast as a read receipt, leaking
	// the admin's presence to the real participants.
	const isMember = await db.isSortedSetMember(`chat:room:${roomId}:uids`, uid);
	if (!isMember) {
		throw new Error('[[error:no-privileges]]');
	}
}

// Called by a participant's client when they are actively viewing the room.
// Records the "seen" timestamp and broadcasts it to everyone currently in the room.
async function markSeen(socket, data) {
	const uid = socket.uid;
	const roomId = data && parseInt(data.roomId, 10);
	await assertInRoom(uid, roomId);

	const now = Date.now();
	await db.setObjectField(roomKey(roomId), uid, now);

	sockets.in(`chat_room_${roomId}`).emit('event:chat-read-receipts.seen', {
		roomId: roomId,
		uid: parseInt(uid, 10),
		timestamp: now,
	});

	return { timestamp: now };
}

// Returns the last-seen timestamp for every participant of the room, so a client
// can render read receipts on the messages it has loaded.
async function getRoomReadState(socket, data) {
	const uid = socket.uid;
	const roomId = data && parseInt(data.roomId, 10);
	await assertInRoom(uid, roomId);

	const uids = (await Messaging.getUidsInRoom(roomId, 0, -1))
		.map(u => parseInt(u, 10))
		.filter(u => u > 0);

	const [pluginRead, coreRead, usersData] = await Promise.all([
		db.getObjectFields(roomKey(roomId), uids.map(String)),
		db.getObjectsFields(uids.map(u => `uid:${u}:chat:rooms:read`), [String(roomId)]),
		user.getUsersFields(uids, ['uid', 'username', 'userslug', 'picture', 'icon:text', 'icon:bgColor']),
	]);

	const users = usersData.map((u, index) => {
		const fromPlugin = parseInt(pluginRead[u.uid], 10) || 0;
		const fromCore = parseInt(coreRead[index] && coreRead[index][roomId], 10) || 0;
		return {
			uid: parseInt(u.uid, 10),
			username: u.username,
			userslug: u.userslug,
			picture: u.picture,
			'icon:text': u['icon:text'],
			'icon:bgColor': u['icon:bgColor'],
			timestamp: Math.max(fromPlugin, fromCore),
		};
	});

	return {
		roomId: roomId,
		participantCount: uids.length,
		users: users,
	};
}

module.exports = plugin;
