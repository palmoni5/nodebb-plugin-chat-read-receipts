'use strict';

/* global $, app, ajaxify, socket, config */

(function () {
	const RR = window.chatReadReceipts || (window.chatReadReceipts = {});

	// roomId -> { count: <participantCount>, byUid: { uid: lastSeenTs } }
	RR.rooms = RR.rooms || {};
	RR.loading = RR.loading || {};
	RR.lastMarkSeen = RR.lastMarkSeen || {};
	RR.socketBound = RR.socketBound || false;

	const isHebrew = (document.documentElement.lang || 'en').startsWith('he');
	const txt = {
		sent: isHebrew ? 'נשלח' : 'Sent',
		read: isHebrew ? 'נקרא' : 'Read',
		readByAll: isHebrew ? 'נקרא ע״י כולם' : 'Read by all',
		readByN: isHebrew ? 'נקרא ע״י %1' : 'Read by %1',
		readByNames: isHebrew ? 'נקרא ע״י: %1' : 'Read by: %1',
		notReadYet: isHebrew ? 'טרם נקרא' : 'Not read yet',
	};

	function myUid() {
		return parseInt(app.user.uid, 10);
	}

	function format(str, arg) {
		return str.replace('%1', arg);
	}

	// All currently-rendered message-list containers and their room ids.
	function eachRoomContainer(fn) {
		$('[component="chat/message/content"][data-roomid]').each(function () {
			const el = $(this);
			const roomId = parseInt(el.attr('data-roomid'), 10);
			if (roomId > 0) {
				fn(el, roomId);
			}
		});
	}

	function loadRoomState(roomId, callback) {
		if (RR.loading[roomId]) {
			return;
		}
		RR.loading[roomId] = true;
		socket.emit('plugins.chatReadReceipts.getRoomReadState', { roomId: roomId }, function (err, data) {
			RR.loading[roomId] = false;
			if (err || !data) {
				return;
			}
			const byUid = {};
			(data.users || []).forEach(function (u) {
				byUid[u.uid] = { ts: parseInt(u.timestamp, 10) || 0, name: u.username };
			});
			RR.rooms[roomId] = { count: data.participantCount, byUid: byUid };
			renderRoom(roomId);
			if (typeof callback === 'function') {
				callback();
			}
		});
	}

	// Compute the receipt for one of *my* outgoing messages, given the room state.
	function buildReceipt(state, msgTs) {
		const others = [];
		Object.keys(state.byUid).forEach(function (uid) {
			if (parseInt(uid, 10) !== myUid()) {
				others.push(state.byUid[uid]);
			}
		});
		const totalOthers = others.length;
		const readers = others.filter(function (o) {
			return o.ts >= msgTs;
		});
		const readerNames = readers.map(function (o) {
			return o.name;
		});

		// One-on-one room: a single "other" participant.
		if (totalOthers <= 1) {
			if (readers.length >= 1) {
				return { html: '<i class="fa fa-check-double"></i>', cls: 'read', title: txt.read };
			}
			return { html: '<i class="fa fa-check"></i>', cls: 'sent', title: txt.sent };
		}

		// Group room: more than one other participant.
		if (readers.length === 0) {
			return { html: '<i class="fa fa-check"></i>', cls: 'sent', title: txt.sent };
		}
		if (readers.length >= totalOthers) {
			return {
				html: '<i class="fa fa-check-double"></i> ' + txt.readByAll,
				cls: 'read',
				title: format(txt.readByNames, readerNames.join(', ')),
			};
		}
		return {
			html: '<i class="fa fa-eye"></i> ' + format(txt.readByN, readers.length + '/' + totalOthers),
			cls: 'partial',
			title: format(txt.readByNames, readerNames.join(', ')),
		};
	}

	function renderContainer(containerEl, state) {
		const mine = myUid();
		containerEl.find('[component="chat/message"]').each(function () {
			const msgEl = $(this);
			if (parseInt(msgEl.attr('data-uid'), 10) !== mine) {
				return;
			}
			if (msgEl.hasClass('deleted')) {
				msgEl.find('.chat-read-receipt').remove();
				return;
			}
			const msgTs = parseInt(msgEl.attr('data-timestamp'), 10) || 0;
			const receipt = buildReceipt(state, msgTs);

			let el = msgEl.find('> .chat-read-receipt');
			if (!el.length) {
				el = $('<div class="chat-read-receipt"></div>');
				msgEl.append(el);
			}
			el.attr('class', 'chat-read-receipt chat-read-receipt-' + receipt.cls)
				.attr('title', receipt.title)
				.html(receipt.html);
		});
	}

	function renderRoom(roomId) {
		const state = RR.rooms[roomId];
		if (!state) {
			return;
		}
		$('[component="chat/message/content"][data-roomid="' + roomId + '"]').each(function () {
			renderContainer($(this), state);
		});
	}

	function renderAll() {
		eachRoomContainer(function (el, roomId) {
			if (RR.rooms[roomId]) {
				renderRoom(roomId);
			} else {
				loadRoomState(roomId);
			}
		});
	}

	// Tell the server we (the local user) have seen this room's messages, so the
	// other participants' clients can update their receipts. Debounced per room.
	function markSeen(roomId) {
		const now = Date.now();
		if (RR.lastMarkSeen[roomId] && (now - RR.lastMarkSeen[roomId]) < 1000) {
			return;
		}
		RR.lastMarkSeen[roomId] = now;
		socket.emit('plugins.chatReadReceipts.markSeen', { roomId: roomId }, function () {});
	}

	function markVisibleRoomsSeen() {
		if (document.hidden || !document.hasFocus()) {
			return;
		}
		eachRoomContainer(function (el, roomId) {
			// Only mark a room seen if its message window is actually visible.
			if (el.is(':visible')) {
				markSeen(roomId);
			}
		});
	}

	function bindSocket() {
		if (RR.socketBound || typeof socket === 'undefined') {
			return;
		}
		RR.socketBound = true;
		socket.on('event:chat-read-receipts.seen', function (data) {
			if (!data || !data.roomId) {
				return;
			}
			const roomId = parseInt(data.roomId, 10);
			const state = RR.rooms[roomId];
			if (!state) {
				return;
			}
			const uid = parseInt(data.uid, 10);
			if (!state.byUid[uid]) {
				state.byUid[uid] = { ts: 0, name: '' };
			}
			state.byUid[uid].ts = Math.max(state.byUid[uid].ts, parseInt(data.timestamp, 10) || 0);
			renderRoom(roomId);
		});
	}

	function onRoomActivity() {
		bindSocket();
		renderAll();
		markVisibleRoomsSeen();
	}

	// Bind DOM/window listeners only once, even if this script is loaded twice
	// (it is registered via both plugin.json "scripts" and filter:scripts.client).
	function bindDom() {
		if (RR.domBound) {
			return;
		}
		RR.domBound = true;

		$(window).on('action:ajaxify.end', onRoomActivity);
		$(window).on('action:chat.loaded', onRoomActivity);

		// A new message was appended (incoming or our own). Re-render and, if it
		// arrived while we're watching, mark the room seen.
		$(window).on('action:chat.received', function () {
			renderAll();
			markVisibleRoomsSeen();
		});

		$(window).on('action:chat.sent', function () {
			// Our own message: refresh receipts (shows "sent" until others read it).
			setTimeout(renderAll, 100);
		});

		// When the user refocuses the tab/window, let others know we've seen the room.
		$(window).on('focus', markVisibleRoomsSeen);
		$(document).on('visibilitychange', function () {
			if (!document.hidden) {
				markVisibleRoomsSeen();
			}
		});
	}

	bindDom();

	$(document).ready(function () {
		bindSocket();
		onRoomActivity();
	});
}());
