'use strict';

/* global $, app, ajaxify, socket, config */

(function () {
	const RR = window.chatReadReceipts || (window.chatReadReceipts = {});

	// roomId -> { count: <participantCount>, byUid: { uid: lastSeenTs } }
	RR.rooms = RR.rooms || {};
	RR.loading = RR.loading || {};
	RR.lastMarkSeen = RR.lastMarkSeen || {};
	RR.socketBound = RR.socketBound || false;
	// Events that arrive while state is still loading, keyed by roomId.
	RR.pendingEvents = RR.pendingEvents || {};

	// Cache translation promises so each string is only resolved once, even when
	// many messages request the same label.
	const translationCache = {};
	function t(str) {
		if (!translationCache[str]) {
			translationCache[str] = new Promise(resolve => require(['translator'], translator =>
				translator.translate(str, resolve)
			));
		}
		return translationCache[str];
	}

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

	function applySeenEvent(state, data) {
		const uid = parseInt(data.uid, 10);
		if (!state.byUid[uid]) {
			state.byUid[uid] = { ts: 0, name: '' };
		}
		state.byUid[uid].ts = Math.max(state.byUid[uid].ts, parseInt(data.timestamp, 10) || 0);
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

			// Apply any seen events that arrived while state was loading.
			if (RR.pendingEvents[roomId]) {
				RR.pendingEvents[roomId].forEach(ev => applySeenEvent(RR.rooms[roomId], ev));
				delete RR.pendingEvents[roomId];
			}

			renderRoom(roomId);
			if (typeof callback === 'function') {
				callback();
			}
		});
	}

	// Compute the receipt for one of *my* outgoing messages, given the room state.
	async function buildReceipt(state, msgTs) {
		const others = Object.keys(state.byUid)
			.filter(uid => parseInt(uid, 10) !== myUid())
			.map(uid => state.byUid[uid]);
		const totalOthers = others.length;
		const readers = others.filter(o => o.ts >= msgTs);
		const readerNames = readers.map(o => o.name).join(', ');

		// One-on-one room: a single "other" participant.
		if (totalOthers <= 1) {
			if (readers.length >= 1) {
				return { html: '<i class="fa fa-check-double"></i>', cls: 'read', title: await t('[[chat-read-receipts:read]]') };
			}
			return { html: '<i class="fa fa-check"></i>', cls: 'sent', title: await t('[[chat-read-receipts:sent]]') };
		}

		// Group room: more than one other participant.
		if (readers.length === 0) {
			return { html: '<i class="fa fa-check"></i>', cls: 'sent', title: await t('[[chat-read-receipts:sent]]') };
		}
		if (readers.length >= totalOthers) {
			return {
				html: '<i class="fa fa-check-double"></i> ' + await t('[[chat-read-receipts:read-by-all]]'),
				cls: 'read',
				title: format(await t('[[chat-read-receipts:read-by-names]]'), readerNames),
			};
		}
		return {
			html: '<i class="fa fa-eye"></i> ' + format(await t('[[chat-read-receipts:read-by-n]]'), readers.length + '/' + totalOthers),
			cls: 'partial',
			title: format(await t('[[chat-read-receipts:read-by-names]]'), readerNames),
		};
	}

	async function renderContainer(containerEl, state) {
		const mine = myUid();
		const msgs = containerEl.find('[component="chat/message"]').toArray();

		// Build all receipts in parallel, then apply them to the DOM synchronously.
		const items = await Promise.all(msgs.map(async (el) => {
			const msgEl = $(el);
			if (parseInt(msgEl.attr('data-uid'), 10) !== mine) {
				return null;
			}
			if (msgEl.hasClass('deleted')) {
				return { msgEl, deleted: true };
			}
			const msgTs = parseInt(msgEl.attr('data-timestamp'), 10) || 0;
			const receipt = await buildReceipt(state, msgTs);
			return { msgEl, receipt };
		}));

		items.forEach((item) => {
			if (!item) {
				return;
			}
			if (item.deleted) {
				item.msgEl.find('.chat-read-receipt').remove();
				return;
			}
			const body = item.msgEl.find('[component="chat/message/body"]');
			let rEl = body.find('.chat-read-receipt');
			if (!rEl.length) {
				rEl = $('<span class="chat-read-receipt"></span>');
				// Append inside the message text (the trailing block, usually the
				// last <p>) so the receipt floats onto the end of the final line
				// instead of taking a separate row beneath the message.
				const host = body.children().last();
				(host.length ? host : body).append(rEl);
			}
			rEl.attr('class', 'chat-read-receipt chat-read-receipt-' + item.receipt.cls)
				.attr('title', item.receipt.title)
				.html(item.receipt.html);
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

		// NodeBB fires this whenever the REST API marks a room as read
		// (opening a modal, maximizing from taskbar, mousemove on unread modal, etc.).
		// Piggybacking on it ensures we never miss a read that the core already detected.
		socket.on('event:chats.markedAsRead', function (data) {
			if (!data || !data.roomId) {
				return;
			}
			markSeen(parseInt(data.roomId, 10));
		});

		socket.on('event:chat-read-receipts.seen', function (data) {
			if (!data || !data.roomId) {
				return;
			}
			const roomId = parseInt(data.roomId, 10);
			const state = RR.rooms[roomId];
			if (!state) {
				// State is still loading — queue so the event isn't lost.
				if (!RR.pendingEvents[roomId]) {
					RR.pendingEvents[roomId] = [];
				}
				RR.pendingEvents[roomId].push(data);
				return;
			}
			applySeenEvent(state, data);
			renderRoom(roomId);
		});
	}

	function onRoomActivity() {
		bindSocket();
		renderAll();
		markVisibleRoomsSeen();
	}

	// Bind DOM/window listeners only once.
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
