#!/usr/bin/env node
/**
 * dgtp-reddit-reader — read-only Reddit Data API client for Disc Golf Trading Post.
 *
 * For each disc model in a list, it makes ONE search request in r/discgolf and
 * reads the comments of the few most relevant threads, then writes the text
 * (no usernames, no ids, no links) to a temporary working folder. Our team
 * summarizes each disc's consensus in our own words, then runs `purge`,
 * which deletes the working folder. Nothing from Reddit is kept after that.
 *
 * What it never does: post, comment, vote, message, moderate, or read any
 * subreddit other than r/discgolf. It only ever calls the two GET endpoints
 * below, with the `read` scope, at most one request per second.
 *
 * Usage:
 *   node reader.mjs plan  discs.json   # print the requests it WOULD make; no network
 *   node reader.mjs run   discs.json   # make them; write ./work/<date>/<disc>.txt
 *   node reader.mjs purge              # delete ./work entirely
 *
 * Environment (put in .env, never commit it):
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET   from reddit.com/prefs/apps ("script" app)
 *   REDDIT_USERNAME                          the account that owns the app (for the User-Agent)
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const SUBREDDIT = "discgolf";
const THREADS_PER_DISC = 3;
const COMMENTS_PER_THREAD = 25;
const MIN_MS_BETWEEN_REQUESTS = 1000;
const WORK_DIR = "work";
const VERSION = "0.1.0";

// ── tiny .env loader (no dependencies) ──────────────────────────────────────
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const userAgent = () =>
  `script:dgtp-reddit-reader:v${VERSION} (by /u/${process.env.REDDIT_USERNAME ?? "unknown"})`;

/** Discs file: [{ "key": "innova/destroyer", "query": "Innova Destroyer" }, ...] */
function loadDiscs(path) {
  const discs = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(discs) || discs.some((d) => !d.key || !d.query)) {
    throw new Error(`${path}: expected an array of { key, query }`);
  }
  return discs;
}

const searchUrl = (query) =>
  `https://oauth.reddit.com/r/${SUBREDDIT}/search?` +
  new URLSearchParams({ q: query, restrict_sr: "1", sort: "relevance", t: "all", limit: String(THREADS_PER_DISC), raw_json: "1" });

const commentsUrl = (postId) =>
  `https://oauth.reddit.com/r/${SUBREDDIT}/comments/${postId}?` +
  new URLSearchParams({ sort: "top", limit: String(COMMENTS_PER_THREAD), depth: "1", raw_json: "1" });

// ── HTTP: app-only OAuth, throttled, GET only ───────────────────────────────
let token = null;
let lastRequestAt = 0;

async function getToken() {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret || !process.env.REDDIT_USERNAME) {
    throw new Error("Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_USERNAME (see README).");
  }
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "read" }),
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function get(url) {
  const wait = lastRequestAt + MIN_MS_BETWEEN_REQUESTS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  token ??= await getToken();
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: { Authorization: `bearer ${token}`, "User-Agent": userAgent() } });

  // Back off if Reddit says we're near the limit.
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(remaining) && remaining < 5 && Number.isFinite(reset)) {
    console.log(`  rate limit nearly used; pausing ${reset}s`);
    await new Promise((r) => setTimeout(r, reset * 1000));
  }
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

// ── text extraction: content only; usernames, ids and links are dropped ────
const clean = (s) => (s ?? "").replace(/https?:\/\/\S+/g, "[link]").replace(/\/?u\/[A-Za-z0-9_-]+/g, "[user]").trim();

async function readDisc(disc) {
  const search = await get(searchUrl(disc.query));
  const posts = (search?.data?.children ?? []).map((c) => c.data).filter((p) => !p.over_18);
  const parts = [`# ${disc.query}`];
  for (const p of posts) {
    const thread = await get(commentsUrl(p.id));
    const comments = (thread?.[1]?.data?.children ?? [])
      .filter((c) => c.kind === "t1" && c.data?.body && c.data.body !== "[deleted]" && c.data.body !== "[removed]")
      .map((c) => `- ${clean(c.data.body)}`);
    parts.push(`\n## ${clean(p.title)} (${new Date(p.created_utc * 1000).getFullYear()})`, clean(p.selftext), ...comments);
  }
  return { text: parts.join("\n"), threads: posts.length };
}

// ── commands ────────────────────────────────────────────────────────────────
const [cmd, file] = process.argv.slice(2);

if (cmd === "plan" || cmd === "run") {
  if (!file) throw new Error(`usage: node reader.mjs ${cmd} discs.json`);
  const discs = loadDiscs(file);
  const maxRequests = discs.length * (1 + THREADS_PER_DISC) + 1;
  console.log(`r/${SUBREDDIT} · ${discs.length} discs · at most ${maxRequests} GET requests · ≥${MIN_MS_BETWEEN_REQUESTS} ms apart`);
  console.log(`User-Agent: ${userAgent()}\n`);
  if (cmd === "plan") {
    for (const d of discs) console.log(`  ${d.key.padEnd(40)} search "${d.query}" + up to ${THREADS_PER_DISC} threads`);
    console.log("\nPLAN ONLY — no network calls made. Use `run` to execute.");
  } else {
    const dir = `${WORK_DIR}/${new Date().toISOString().slice(0, 10)}`;
    mkdirSync(dir, { recursive: true });
    for (const d of discs) {
      const { text, threads } = await readDisc(d);
      writeFileSync(`${dir}/${d.key.replace(/[^a-z0-9-]+/gi, "_")}.txt`, text);
      console.log(`  ${d.key.padEnd(40)} ${threads} threads`);
    }
    console.log(`\nWrote ${dir}/. Summarize, then run \`node reader.mjs purge\` to delete it.`);
  }
} else if (cmd === "purge") {
  rmSync(WORK_DIR, { recursive: true, force: true });
  console.log(`Deleted ./${WORK_DIR}. No Reddit content remains.`);
} else {
  console.log("usage: node reader.mjs plan|run discs.json  ·  node reader.mjs purge");
  process.exitCode = 1;
}
