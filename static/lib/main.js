'use strict';

/* global $, app, ajaxify, socket, config */

(function () {
	const RR = window.chatReadReceipts || (window.chatReadReceipts = {});

	// roomId -> { count: <participantCount>, byUid: { uid: lastSeenTs } }
	RR.rooms = RR.rooms || {};
	RR.loading = RR.loading || {};
	RR.lastMarkSeen = RR.lastMarkSeen || {};
	// Pending trailing markSeen timers (keyed by roomId) so a throttled call's
	// final state still reaches the server.
	RR.trailingSeen = RR.trailingSeen || {};
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

			const state = RR.rooms[roomId];
			$('[component="chat/message/content"][data-roomid="' + roomId + '"]').each(function () {
				const containerEl = $(this);
				renderContainer(containerEl, state);
				// One-time only: if this container was just opened, position the view
				// at the first unread message (or leave native scroll-to-bottom alone).
				if (containerEl[0].hasAttribute('data-rr-initial')) {
					positionInitialView(containerEl, roomId);
				}
			});

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
			// Attach to the message-body-wrapper (NOT the body itself, which has
			// overflow-auto and would clip an absolutely-positioned child) so the
			// receipt can sit pinned to the bottom corner of the message.
			let host = item.msgEl.find('.message-body-wrapper');
			if (!host.length) {
				host = item.msgEl.find('[component="chat/message/body"]');
			}
			let rEl = host.children('.chat-read-receipt');
			if (!rEl.length) {
				rEl = $('<span class="chat-read-receipt"></span>');
				host.append(rEl);
			}
			rEl.attr('class', 'chat-read-receipt chat-read-receipt-' + item.receipt.cls)
				.attr('title', item.receipt.title)
				.html(item.receipt.html);
		});
	}

	// Restore NodeBB's native scroll-to-bottom for a freshly-opened container and
	// clear the one-shot flag so the scroll patch never touches this room again.
	function finishInitial(containerEl, scrollToBottom) {
		containerEl[0].removeAttribute('data-rr-initial');
		if (scrollToBottom) {
			require(['forum/chats/messages'], function (messages) {
				// Flag is cleared, so the patched fn falls through to the original.
				messages.scrollToBottomAfterImageLoad(containerEl);
			});
		}
	}

	// Called exactly once per room open. If there are unread messages, insert the
	// "new messages" divider and scroll to it; otherwise leave NodeBB's normal
	// scroll-to-bottom behaviour completely untouched.
	function positionInitialView(containerEl, roomId, opts) {
		opts = opts || {};
		const state = RR.rooms[roomId];
		if (!state) {
			finishInitial(containerEl, true);
			return;
		}
		containerEl.find('.chat-unread-divider').remove();

		// Capture the pre-visit last-seen timestamp ONCE and thread it through the
		// (async) load-more retries below. Our own markSeen fires right after this in
		// loadRoomState and round-trips an event:chat-read-receipts.seen that bumps
		// state.byUid[me].ts up to the latest message. If a retry re-read myTs from
		// state, every message would suddenly look read and the divider would vanish.
		let myTs = opts.baselineTs;
		if (myTs === undefined) {
			const myState = state.byUid[myUid()];
			myTs = myState ? myState.ts : 0;
			opts.baselineTs = myTs;
		}
		if (myTs === 0) {
			// No recorded last-seen timestamp — treat as nothing-unread: native bottom.
			finishInitial(containerEl, true);
			return;
		}

		// Find the divider boundary: the first message AFTER the last one I'm known
		// to have seen. A "seen" message is either one with timestamp <= my pre-visit
		// last-seen, OR one of MY OWN messages — sending a message proves I'd already
		// seen everything before it. This guarantees the "New messages" divider is
		// never placed before one of my own messages.
		const msgs = containerEl.find('[component="chat/message"]').toArray();
		const mine = myUid();
		let lastReadIndex = -1;
		for (let i = 0; i < msgs.length; i++) {
			const el = msgs[i];
			const isMine = parseInt($(el).attr('data-uid'), 10) === mine;
			const msgTs = parseInt($(el).attr('data-timestamp'), 10) || 0;
			if (isMine || msgTs <= myTs) {
				lastReadIndex = i;
			}
		}
		const firstUnreadEl = (lastReadIndex >= 0 && lastReadIndex + 1 < msgs.length) ?
			msgs[lastReadIndex + 1] : null;

		if (lastReadIndex === -1 && msgs.length) {
			// Nothing in this batch counts as read — the boundary lies in older
			// messages not yet in the DOM. Load one more batch and retry.
			if ((opts.depth || 0) >= 50) {
				finishInitial(containerEl, true); // give up; behave like native.
				return;
			}
			const countBefore = msgs.length;
			require(['forum/chats/messages'], function (messages) {
				messages.loadMoreMessages(containerEl, myUid(), roomId, -1).then(function () {
					const countAfter = containerEl.find('[component="chat/message"]').length;
					if (countAfter > countBefore) {
						positionInitialView(containerEl, roomId,
							Object.assign({}, opts, { depth: (opts.depth || 0) + 1 }));
					} else {
						finishInitial(containerEl, true);
					}
				}).catch(function () {
					finishInitial(containerEl, true);
				});
			});
			return;
		}

		if (!firstUnreadEl) {
			// Everything loaded is already read — native scroll-to-bottom.
			finishInitial(containerEl, true);
			return;
		}

		const divider = $('<div class="chat-unread-divider"><span></span></div>');
		$(firstUnreadEl).before(divider);

		t('[[chat-read-receipts:new-messages]]').then(function (label) {
			divider.find('span').text(label);
		});

		// We own the scroll now: clear the flag and scroll to the divider once,
		// using NodeBB's image-aware helper so image height shifts are accounted for.
		containerEl[0].removeAttribute('data-rr-initial');
		require(['forum/chats/messages'], function (messages) {
			messages.scrollToMessageAfterImageLoad(containerEl, divider);
		});
	}

	function renderRoomReceipts(roomId) {
		const state = RR.rooms[roomId];
		if (!state) {
			return;
		}
		$('[component="chat/message/content"][data-roomid="' + roomId + '"]').each(function () {
			renderContainer($(this), state);
		});
	}

	function renderAllReceipts() {
		eachRoomContainer(function (el, roomId) {
			if (RR.rooms[roomId]) {
				renderRoomReceipts(roomId);
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
			// Throttled. Schedule one trailing pass so the newest message timestamp
			// isn't lost when several markSeen calls bunch up (e.g. a batch of
			// messages rendering in under a second).
			if (!RR.trailingSeen[roomId]) {
				RR.trailingSeen[roomId] = setTimeout(function () {
					RR.trailingSeen[roomId] = null;
					if (document.hidden || !document.hasFocus()) {
						return;
					}
					const live = $('[component="chat/message/content"][data-roomid="' + roomId + '"]')
						.filter(':visible').first();
					if (live.length) {
						markSeen(roomId, live);
					}
				}, 1000);
			}
			return;
		}
		if (RR.trailingSeen[roomId]) {
			clearTimeout(RR.trailingSeen[roomId]);
			RR.trailingSeen[roomId] = null;
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
			renderRoomReceipts(roomId);
		});
	}

	function onRoomActivity() {
		bindSocket();
		renderAllReceipts();
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

		// Intercept NodeBB's scrollToBottomAfterImageLoad ONLY during the one-time
		// initial open of a room (while we wait for its read-state from the server).
		// The gate is a one-shot per-container flag — never divider presence — so
		// once a room is open, every later scroll behaves exactly like core NodeBB.
		require(['forum/chats/messages'], function (messagesModule) {
			if (messagesModule._rrPatched) {
				return;
			}
			messagesModule._rrPatched = true;
			const orig = messagesModule.scrollToBottomAfterImageLoad;
			messagesModule.scrollToBottomAfterImageLoad = function (containerEl) {
				if (containerEl && containerEl.length &&
						containerEl[0].hasAttribute('data-rr-initial')) {
					return; // suppress until positionInitialView decides where to scroll
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
			// When core is deep-linking to a specific message it sets
			// ajaxify.data.scrollToIndex and owns the scroll (it scrolls to and
			// highlights that message before firing this event). In that case we must
			// NOT flag the room for initial divider positioning — otherwise
			// positionInitialView would yank the view to the unread divider or the
			// bottom and break the deep link.
			const deepLinkRoomId = (window.ajaxify && ajaxify.data && ajaxify.data.scrollToIndex) ?
				parseInt(ajaxify.data.roomId, 10) : 0;
			eachRoomContainer(function (el, roomId) {
				// Drop cached state so the next loadRoomState always fetches a
				// fresh timestamp — covers the full-page room-switch case where
				// action:chat.closed is never fired.
				delete RR.rooms[roomId];
				delete RR.lastMarkSeen[roomId];
				// Mark this container as "just opened": suppress native bottom-scroll
				// until positionInitialView runs once with the server's read-state.
				if (roomId !== deepLinkRoomId) {
					el[0].setAttribute('data-rr-initial', '1');
				}
			});
			onRoomActivity();
		});

		// A new message was appended (incoming or our own). Only refresh the receipt
		// ticks and mark the room seen — never touch the divider or scrolling, so
		// NodeBB's native scroll-to-bottom-on-new-message behaviour is preserved.
		$(window).on('action:chat.received', function () {
			renderAllReceipts();
			markVisibleRoomsSeen();
		});

		// Re-render receipts whenever a batch of messages is added to the DOM
		// (both on initial load and on scroll-up lazy loading). Once a room's
		// one-time initial positioning is done (data-rr-initial cleared), also
		// advance our seen-timestamp so reading on this device propagates to the
		// shared server hash — closing the cross-device gap where a message that
		// loaded after the initial markSeen stayed "unread" on other devices. We
		// skip while data-rr-initial is still set so we never clobber the pre-visit
		// baseline the divider depends on.
		$(window).on('action:chat.onMessagesAddedToDom', function () {
			renderAllReceipts();
			if (document.hidden || !document.hasFocus()) {
				return;
			}
			eachRoomContainer(function (el, roomId) {
				if (!el[0].hasAttribute('data-rr-initial') && el.is(':visible')) {
					markSeen(roomId, el);
				}
			});
		});

		$(window).on('action:chat.sent', function () {
			// Our own message: refresh receipts (shows "sent" until others read it)
			// and advance our own seen-timestamp — sending implies we've seen
			// everything up to and including this message.
			setTimeout(function () {
				renderAllReceipts();
				markVisibleRoomsSeen();
			}, 100);
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
