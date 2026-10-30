'use strict';
// Grok Bot source: one office worker per Grok Bot agent on this box.
// Read-only: profile.json names + per-agent message role/timestamps from the
// app's search index (opened with SQLite mode=ro). Message bodies are never
// returned except a single "ends with a question mark" boolean.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { newSession } = require('./parsers');

const ROOT = process.env.GROKBOT_DATA || '/home/box/agent-data';
const PY = `
import sqlite3,json,sys
db=sys.argv[1]; out={}
try:
  c=sqlite3.connect('file:'+db+'?mode=ro',uri=True,timeout=1)
  for a,r,t in c.execute("select agent_id,role,max(timestamp_ms) from messages group by agent_id,role"):
    out.setdefault(a,{})[r]=t
  for a in out:
    row=c.execute("select role,substr(rtrim(body),-1) from messages where agent_id=? order by timestamp_ms desc limit 1",(a,)).fetchone()
    if row: out[a]['lastRole']=row[0]; out[a]['ask']=row[0]=='assistant' and row[1] in ('?','？')
  c.close()
except Exception as e: out={'_error':str(e)}
print(json.dumps(out))`;
const TOOL_PROCS = { ffmpeg: 'ffmpeg', chrome: 'Browser', chromium: 'Browser', 'headless_shell': 'Browser', curl: 'curl', git: 'git', npm: 'npm', npx: 'npx', pip: 'pip', python3: 'python3', pdftotext: 'pdftotext' };

function profiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(ROOT, 'agents'), { withFileTypes: true }); } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', d.name, 'profile.json'), 'utf8'));
      out.push({ id: d.name, name: p.name || d.name.slice(0, 8) });
    } catch {}
  }
  return out;
}

// Busy box processes (not attributable to a specific bot; given to the most recently active one).
function boxTool(cb) {
  execFile('ps', ['-eo', 'pid,ppid,etimes,comm,args', '--no-headers'], { timeout: 2000 }, (err, so) => {
    if (err) return cb(null);
    const self = String(process.pid);
    for (const line of so.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m || m[1] === self || m[2] === self) continue;
      const comm = m[4];
      if (/grokbot-sample|whatsmyagentdoing|record\.mjs/.test(m[5])) continue;
      const hit = Object.keys(TOOL_PROCS).find((k) => comm.startsWith(k));
      if (hit && hit !== 'python3') return cb(`Shell·${TOOL_PROCS[hit]}`);
    }
    cb(null);
  });
}

class GrokBotSource {
  constructor({ interval = 3000 } = {}) { this.interval = interval; this.sessions_ = []; this.listeners = []; }
  on(_, fn) { this.listeners.push(fn); }
  start() { this.tick(); this.timer = setInterval(() => this.tick(), this.interval); return this; }
  stop() { clearInterval(this.timer); }
  tick() {
    const db = path.join(ROOT, 'search-index.db');
    execFile('python3', ['-c', PY, db], { timeout: 4000 }, (err, so) => {
      let idx = {};
      try { idx = JSON.parse(so); } catch {}
      boxTool((tool) => {
        const now = Date.now();
        const list = profiles().map((p) => {
          const r = idx[p.id] || {};
          const lu = r.user || 0, la = r.assistant || 0, last = Math.max(lu, la);
          const s = newSession('grokbot', p.id, null);
          s.title = p.name; s.agentName = p.name; s.cwd = null;
          s.lastEventAt = last || null; s.startedAt = last || null;
          const q = now - last;
          if (!last || q > 6 * 3600_000) s.status = 'idle';
          else if (q < 10 * 60_000) {
            // Recent traffic: the bot is mid-turn (Grok Bot posts interim notes while it works).
            s.status = r.lastRole === 'assistant' && q < 60_000 ? 'typing' : 'thinking';
            s.turnStartedAt = lu || null;
          } else if (r.ask) s.status = 'waiting', s.activity = '等你回复';
          else s.status = r.lastRole === 'assistant' ? 'done' : 'idle';
          if (s.status === 'typing' && q < 60_000) s.explicitLifecycle = true;
          return s;
        });
        const active = list.filter((s) => s.status === 'thinking' || s.status === 'typing')
          .sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
        if (active && tool) { active.status = 'tool'; active.activity = tool; }
        const key = JSON.stringify(list.map((s) => [s.id, s.status, s.activity, s.lastEventAt]));
        this.sessions_ = list;
        if (key !== this.key) { this.key = key; for (const fn of this.listeners) fn(); }
      });
    });
  }
  sessions() { return this.sessions_; }
}
module.exports = { GrokBotSource };
