# dgtp-reddit-reader

A small, **read-only** Reddit Data API client used by [Disc Golf Trading Post](https://disctradingpost.com) (operated by Last Tree Disc Golf LLC, NJ).

Disc golf manufacturers print "flight numbers" that players know are often misleading. r/discgolf is where players work out how discs actually fly. This script reads that public discussion for a list of disc models so our team can write short, original notes such as *"players say it flies straighter than its numbers"* for our disc catalog.

The whole client is one file, [`reader.mjs`](reader.mjs), with no dependencies.

## What it does

For each disc model in a list (e.g. "Innova Destroyer"):

1. **One search**, restricted to r/discgolf: `GET /r/discgolf/search?q=…&restrict_sr=1&limit=3`
2. **The top comments of up to 3 matching threads**: `GET /r/discgolf/comments/{id}?sort=top&limit=25&depth=1`
3. It writes the post titles and comment text to a temporary `work/` folder. **Usernames, post ids and links are stripped.** NSFW, deleted and removed content is skipped.

Our team then summarizes each disc's consensus in our own words and runs `purge`, which deletes `work/` entirely.

## What it never does

- **No write actions of any kind.** No posting, commenting, voting, messaging or moderation. It requests only the `read` OAuth scope and calls only the two GET endpoints above.
- **No other subreddits**, no user profiles, no private data.
- **No storage of Reddit content.** It keeps no posts, comments or usernames after `purge`, and displays or republishes none of them.
- **No model training**, and no selling, sharing or reselling of data.

## Rate and volume

- At most **one request per second**, and it backs off when Reddit's rate-limit headers run low.
- The first run is about 150 disc models, roughly 600 requests. After that, at most a weekly run of a few hundred requests for newly released discs.
- It identifies itself with `User-Agent: script:dgtp-reddit-reader:v0.1.0 (by /u/<account>)`.

## Usage

```bash
cp .env.example .env        # fill in the script app's client id/secret and the Reddit username
node reader.mjs plan discs.json    # prints exactly which requests it would make; makes none
node reader.mjs run  discs.json    # makes them; writes work/<date>/*.txt
node reader.mjs purge              # deletes work/
```

`discs.json` is a list of `{ "key": "...", "query": "Brand Mold" }` entries; see `discs.example.json`.

## Contact

Disc Golf Trading Post · https://disctradingpost.com
