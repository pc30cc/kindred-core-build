# Thread paging in the iPhone and Android apps

Since 2026-11-08 the iPhone and Android apps load a conversation 100
messages at a time. The newest page comes first, and scrolling to the top
loads the page before it ("load earlier"). This is the web panel's rule
(`src/lib/threadPages.ts`) plus what the apps need on top: they also take a
`?since=` delta, keep a saved copy, and receive realtime rows.

## The server contract (unchanged since `caaad24`)

`GET /api/conversations/:id/messages`:

- `?limit=100`: the newest page, in thread order `(created_at, id)`, as
  `{ messages, sync: { mode: "full", cursor }, older }`. `older` is
  `{ before, before_id }` while there are earlier messages, and `null` at
  the start of the thread.
- `?limit=100&before=<older.before>&before_id=<older.before_id>`: the page
  before. It carries its own `older` and its own sync cursor.
- `?since=<cursor>`: the delta, with `older: null`.
- No `limit`: still the newest 1000. Installed apps depend on that default,
  so it never changes.

## What an app holds per thread

- **The run**: one contiguous run of the thread's server rows, ending at the
  newest.
- **`older`**: where the page before the run starts. It has three states:
  - unknown (a saved copy from before this change, or a run cut by the
    store's limit);
  - `null` (the run reaches the start of the thread);
  - `{before, before_id}`.

  The two strings are kept exactly as the server sent them, microseconds
  included: the phones' dates keep milliseconds only.
- **The sync cursor and `fullAt`**, as before.

## The rules

1. **Newest-page read** (first open, Clear Cache, a stale or unknown
   `older`, a server error, the periodic reconcile). Ask `limit=100`, then
   merge as the web's `mergeNewestPage` does:
   - If `older` is null, the page is the whole thread.
   - Otherwise every held server row after the page's boundary (`older.before`)
     that the page does not contain was deleted or hidden, so drop it.
     Compare strictly after, in milliseconds: a row inside the boundary's
     millisecond is kept.
   - Held rows before the boundary are kept, but only when the run touches
     the page: the newest held row is at or after the boundary.
   - When the run does not touch the page, more than a page arrived
     meanwhile. The run restarts from the page, never with a hole, and
     `older` becomes the page's.
   - Otherwise `older` stays the run's.
   - The cursor becomes the page's, and `fullAt` becomes now.
   - Realtime rows that landed while the read was out are kept.
2. **An empty or short newest page with `older` set.** Telegram menu taps
   are filtered after the limit, so a page can come back with nothing in it.
   Read past it: up to 4 more pages back, before showing the thread, and
   treat the pages read as one run.
3. **Delta and realtime rows.** A row whose id is already held is merged as
   before. A new row is added only when `older` is null or its `created_at`
   is at or after `older.before`. Otherwise it is dropped: it lies above a
   hole, and loading earlier brings it. Marking seen, a reaction or an
   attachment change bumps an old message's `updated_at` (migrations 216,
   276), so this happens.
4. **Older page** (scrolled to the top, `older` set, nothing else loading).
   - Ask with `before`/`before_id`.
   - Apply it only if the run's `older` is still the one asked with:
     otherwise a newest read restarted the run meanwhile, and the answer is
     dropped.
   - Add its rows before the run, and take its `older`.
   - Never touch the sync cursor or `fullAt`: its cursor is the newest
     `updated_at` of that page.
   - A page with nothing visible and `older` still set is read past, as in
     rule 2.
5. **Deletions.** Deletions inside the newest page are reconciled by every
   newest-page read. Deletions in older loaded pages are not: such a row
   stays until the run is restarted (Clear Cache, a gap, the store's cut).
   A whole conversation that is gone still answers 404, and the app forgets
   it.
6. **The reading position stays put.**
   - When older rows are prepended, the row that was at the top stays where
     it was.
   - Bottom pinning follows only a new newest message, never a prepend.
   - The team chat and support screens, which share the transcript, behave
     as before.
7. **The saved copy.** It holds the run, its newest rows up to the store's
   limit, plus `older`.
   - A copy saved before this change has `older` unknown. It is shown at
     once, and its first read is a newest-page read.
   - A copy cut by the limit has `older` unknown too.
   - Neither is ever an error.

## What a whole read costs now

The periodic reconcile (iPhone and Mac every hour since 2026-11-08, Windows
every hour, Android every 6 h) is a newest-page read: 100 rows, where it
used to be 1000. On the iPhone, a thread longer than the store's 800 rows no
longer means a 1000-row read on every open. It opens from its saved newest
rows and reads 100.

The macOS and Windows apps still read whole (1000). Their paging is a later
change.
