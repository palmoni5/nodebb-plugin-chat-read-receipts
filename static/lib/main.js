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
	// Rooms that need the unread divider inserted on next render.
	RR.dividerNeeded = RR.dividerNeeded || {};

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

			// Mark the room seen NOW — after we've rendered with the pre-visit state.
			// Calling markSeen here (not in onRoomActivity) guarantees the server has
			// already returned the old myTs before we update it to the latest message ts.
			if (document.hasFocus && document.hasFocus() && !document.hidden) {
				$('[component="chat/message/content"][data-roomid="' + roomId + '"]').each(function () {
					const el = $(this);
					if (el.is(':visible')) {
						markSeen(roomId, el);
					}
				});
			}

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
			let rEl = body.children('.chat-read-receipt');
			if (!rEl.length) {
				rEl = $('<span class="chat-read-receipt"></span>');
				body.append(rEl);
			}
			rEl.attr('class', 'chat-read-receipt chat-read-receipt-' + item.receipt.cls)
				.attr('title', item.receipt.title)
				.html(item.receipt.html);
		});
	}

	function insertUnreadDivider(containerEl, roomId, state, opts) {
		opts = opts || {};
		containerEl.find('.chat-unread-divider').remove();

		const myState = state.byUid[myUid()];
		const myTs = myState ? myState.ts : 0;
		if (myTs === 0) {
			containerEl[0].removeAttribute('data-rr-divider-pending');
			return;
		}

		const msgs = containerEl.find('[component="chat/message"]').toArray();
		let firstUnreadEl = null;
		let hasReadBefore = false;

		for (const el of msgs) {
			const msgTs = parseInt($(el).attr('data-timestamp'), 10) || 0;
			if (msgTs <= myTs) {
				hasReadBefore = true;
			} else if (!firstUnreadEl) {
				firstUnreadEl = el;
				break;
			}
		}

		if (!firstUnreadEl) {
			containerEl[0].removeAttribute('data-rr-divider-pending');
			return; // all messages already read
		}

		if (!hasReadBefore) {
			// All currently-loaded messages are unread — the boundary lies in
			// older messages not yet in the DOM.  Load one more batch and retry.
			if ((opts.depth || 0) >= 50) {
				return; // give up after 50 pages to avoid infinite loops
			}
			const countBefore = msgs.length;
			require(['forum/chats/messages'], function (messages) {
				messages.loadMoreMessages(containerEl, myUid(), roomId, -1).then(function () {
					const countAfter = containerEl.find('[component="chat/message"]').length;
					if (countAfter > countBefore) {
						insertUnreadDivider(containerEl, roomId, state,
							Object.assign({}, opts, { depth: (opts.depth || 0) + 1 }));
					}
				}).catch(function () {});
			});
			return;
		}

		const divider = $('<div class="chat-unread-divider"><span></span></div>');
		$(firstUnreadEl).before(divider);

		t('[[chat-read-receipts:new-messages]]').then(function (label) {
			divider.find('span').text(label);
		});

		// Clear the pending flag — we've decided whether a divider is needed.
		containerEl[0].removeAttribute('data-rr-divider-pending');

		if (opts.scroll !== false) {
			const el = containerEl[0];
			if (el.classList.contains('invisible')) {
				// The template's inline rAF hasn't fired yet.  It will scroll to
				// bottom and then remove 'invisible'.  Observe that class removal
				// and scroll to the divider immediately after — this fires right
				// after the rAF and always wins the race, without touching core.
				const obs = new MutationObserver(function () {
					if (!el.classList.contains('invisible')) {
						obs.disconnect();
						if (divider.closest('[component="chat/message/content"]').length) {
							divider[0].scrollIntoView(true);
						}
					}
				});
				obs.observe(el, { attributes: true, attributeFilter: ['class'] });
			} else {
				// rAF already fired (slow socket path) — scroll directly.
				requestAnimationFrame(function () {
					if (divider.closest('[component="chat/message/content"]').length) {
						divider[0].scrollIntoView(true);
					}
				});
			}
		}
	}

	function renderRoom(roomId) {
		const state = RR.rooms[roomId];
		if (!state) {
			return;
		}
		const needsDivider = !!RR.dividerNeeded[roomId];
		delete RR.dividerNeeded[roomId];

		$('[component="chat/message/content"][data-roomid="' + roomId + '"]').each(function () {
			const containerEl = $(this);
			if (needsDivider && containerEl.is(':visible')) {
				insertUnreadDivider(containerEl, roomId, state);
			}
			renderContainer(containerEl, state);
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

	// Tell the server we (the local user) have seen this room's messages.
	// Pass the timestamp of the last message currently in the DOM — NOT Date.now() —
	// so messages that arrive after the DOM was loaded aren't accidentally marked read.
	function markSeen(roomId, containerEl) {
		const now = Date.now();
		if (RR.lastMarkSeen[roomId] && (now - RR.lastMarkSeen[roomId]) < 1000) {
			return;
		}
		RR.lastMarkSeen[roomId] = now;

		let ts = 0;
		if (containerEl) {
			const msgs = containerEl.find('[component="chat/message"]');
			if (msgs.length) {
				ts = parseInt(msgs.last().attr('data-timestamp'), 10) || 0;
			}
		}
		// Fall back to Date.now() only if we couldn't find any message timestamp.
		if (!ts) {
			ts = now;
		}

		socket.emit('plugins.chatReadReceipts.markSeen', { roomId: roomId, timestamp: ts }, function () {});
	}

	function markVisibleRoomsSeen() {
		if (document.hidden || !document.hasFocus()) {
			return;
		}
		eachRoomContainer(function (el, roomId) {
			if (el.is(':visible')) {
				markSeen(roomId, el);
			}
		});
	}

	function removeDivider(roomId) {
		$('[component="chat/message/content"][data-roomid="' + roomId + '"]')
			.find('.chat-unread-divider').remove();
	}

	function bindSocket() {
		if (RR.socketBound || typeof socket === 'undefined') {
			return;
		}
		RR.socketBound = true;

		// NodeBB fires this when it marks a room read internally.
		// We intentionally do NOT call markSeen here — doing so would set myTs=now
		// BEFORE loadRoomState returns, causing the divider logic to see all messages
		// as already read.  markVisibleRoomsSeen() in onRoomActivity handles this in
		// the correct order (getRoomReadState emitted first, markSeen second).
		socket.on('event:chats.markedAsRead', function () {});

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
		// markVisibleRoomsSeen() is NOT called here — it runs inside loadRoomState's
		// callback (after the server has returned the pre-visit myTs) and from the
		// focus/visibilitychange/chat.received handlers below.
	}

	// Bind DOM/window listeners only once.
	function bindDom() {
		if (RR.domBound) {
			return;
		}
		RR.domBound = true;

		// Intercept NodeBB's scrollToBottomAfterImageLoad so it doesn't override
		// our divider scroll when a divider is pending or already present.
		require(['forum/chats/messages'], function (messagesModule) {
			if (messagesModule._rrPatched) {
				return;
			}
			messagesModule._rrPatched = true;
			const orig = messagesModule.scrollToBottomAfterImageLoad;
			messagesModule.scrollToBottomAfterImageLoad = function (containerEl) {
				if (containerEl && containerEl.length) {
					const el = containerEl[0];
					if (el.hasAttribute('data-rr-divider-pending') ||
							el.querySelector('.chat-unread-divider')) {
						return;
					}
				}
				return orig.call(messagesModule, containerEl);
			};
		});

		// On close, drop the cached state so the next open always re-fetches
		// a fresh read-timestamp from the server.
		$(window).on('action:chat.closed', function (ev, data) {
			if (!data || !data.modal) {
				return;
			}
			const roomId = parseInt(data.modal.attr('data-roomid'), 10);
			if (roomId > 0) {
				delete RR.rooms[roomId];
				delete RR.lastMarkSeen[roomId];
			}
		});

		$(window).on('action:ajaxify.end', onRoomActivity);
		$(window).on('action:chat.loaded', function () {
			eachRoomContainer(function (el, roomId) {
				// Drop cached state so the next loadRoomState always fetches a
				// fresh timestamp — covers the full-page room-switch case where
				// action:chat.closed is never fired.
				delete RR.rooms[roomId];
				delete RR.lastMarkSeen[roomId];
				RR.dividerNeeded[roomId] = true;
				// Signal to message-window.tpl's rAF and our scrollToBottom
				// intercept that a divider may be coming — don't scroll to bottom yet.
				el[0].setAttribute('data-rr-divider-pending', '1');
			});
			onRoomActivity();
		});

		// A new message was appended (incoming or our own). Re-render and, if it
		// arrived while we're watching, mark the room seen.
		$(window).on('action:chat.received', function () {
			renderAll();
			markVisibleRoomsSeen();
			// If the user is not actively viewing, the new message is unread —
			// re-position the divider to the first message after their last-seen timestamp.
			if (document.hidden || !document.hasFocus()) {
				eachRoomContainer(function (el, roomId) {
					if (!el.is(':visible')) {
						return;
					}
					const state = RR.rooms[roomId];
					if (!state) {
						return;
					}
					insertUnreadDivider(el, roomId, state, { scroll: false });
				});
			}
		});

		// Re-render receipts whenever a batch of messages is added to the DOM
		// (both on initial load and on scroll-up lazy loading).
		$(window).on('action:chat.onMessagesAddedToDom', function () {
			renderAll();
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
