# nodebb-plugin-chat-read-receipts

Adds WhatsApp-style **read receipts** and an **unread messages divider** to
NodeBB chat.

## Features

### Read receipts

A small indicator is shown next to each of **your own** outgoing messages
(never on other people's messages — same as WhatsApp).

**One-on-one rooms:**
- `✓` (grey) — Sent, not read yet.
- `✓✓` (blue) — Read by the other person.

**Group rooms** — based on each participant's last-seen time:
- `✓` (grey) — nobody else has read it yet.
- `👁 Read by k/N` — read by some participants. Hover to see names.
- `✓✓ Read by all` (blue) — every other participant has read it.

Receipts update live as participants read messages, and also render correctly
for messages loaded lazily when scrolling up.

### Unread messages divider

When you open a chat that has unread messages, a dashed **"New messages"**
divider bar is inserted before the first unread message and the view scrolls
to it automatically (with a small amount of context shown above).

- Works in both popup (minimized) chat windows and the full-page
  `/user/:uid/chats/` view, including sidebar room switching.
- The divider disappears once you close and reopen the chat after reading.
- If a new message arrives while the chat is open but you are on a different
  tab/window, the divider repositions to that message.
- If all unread messages are above the initially-loaded batch, the plugin loads
  older messages until it finds the boundary (up to 50 batches).

## How it works

- When you open a chat, the plugin fetches the per-participant read state
  (`plugins.chatReadReceipts.getRoomReadState`) **before** recording your
  visit, so the pre-visit "last seen" timestamp is used to locate the first
  unread message.
- After rendering the divider, your client sends the timestamp of the last
  loaded message to the server (`plugins.chatReadReceipts.markSeen`). The
  server broadcasts the update so other participants' receipts refresh live.
- The `markSeen` call uses the timestamp of the last message in the DOM — not
  `Date.now()` — so messages that arrive after the snapshot are not
  accidentally marked as read.

## Privacy note

Read receipts are symmetric: if you can see whether others read your messages,
they can see whether you read theirs.
