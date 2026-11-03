import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  Share, StatusBar, StyleSheet, Text, TextInput, Vibration, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

/* ---------- Config ----------
   Free OpenRouter key: https://openrouter.ai/keys (no card needed).
   Free models are limited to ~20 requests/min and ~50 requests/day per account. */
const KEY_STORE = 'autokinetics:orkey';
const DATA_STORE = 'autokinetics:data';

const CATS = [
  { id: 'academics', name: 'Academics', icon: 'school-outline', color: '#60A5FA', focus: 'study systems, learning, exams, reading, deep work' },
  { id: 'mind', name: 'Mind', icon: 'bulb-outline', color: '#C084FC', focus: 'focus, stress, journaling, sleep, emotional resilience' },
  { id: 'body', name: 'Body', icon: 'barbell-outline', color: '#34D399', focus: 'training, nutrition, sleep, recovery, energy' },
  { id: 'discipline', name: 'Discipline', icon: 'locate-outline', color: '#FBBF24', focus: 'routines, willpower, time management, consistency' },
  { id: 'career', name: 'Career', icon: 'briefcase-outline', color: '#FB923C', focus: 'skills, income, projects, networking, financial habits' },
  { id: 'social', name: 'Social', icon: 'people-outline', color: '#F472B6', focus: 'communication, relationships, leadership, confidence' },
];
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[3];
const RANKS = ['Rookie', 'Apprentice', 'Disciplined', 'Sharp', 'Elite', 'Superior', 'Genius', 'Superhuman'];

const PROMPTS = {
  all: ['Plan my day', 'Give me an honest assessment of where I stand', 'Build me a weekly routine across all pillars', 'Run my weekly review'],
  academics: ['Make me a study schedule', 'Teach me how to learn faster', 'Help me beat procrastination on studying'],
  mind: ['Give me a 5-minute focus reset', 'Help me build a journaling habit', 'How do I handle stress better?'],
  body: ['Design a simple workout plan', 'Help me fix my sleep routine', 'Give me a basic nutrition plan'],
  discipline: ['Build a morning routine for me', 'Help me stay consistent with habits', 'Design a distraction-free work block'],
  career: ['Map a 90-day plan to level up my skills', 'Help me build a money-saving system', 'Find my highest-leverage skill to learn'],
  social: ['Teach me to communicate with more confidence', 'Help me build stronger relationships', 'Give me a leadership practice plan'],
};

/* ---------- Helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (off = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const streakOf = (log) => {
  let off = log.includes(dayKey(0)) ? 0 : -1, n = 0;
  while (log.includes(dayKey(off))) { n++; off--; }
  return n;
};
const INTERVALS = [0, 1, 2, 4, 8, 16, 32];
const fmt = (h) => { const t = Math.round((((h % 24) + 24) % 24) * 60), hh = Math.floor(t / 60) % 24; return `${hh % 12 || 12}:${pad(t % 60)} ${hh < 12 ? 'AM' : 'PM'}`; };
const dayRatio = (habits, off) => (habits.length ? habits.filter((h) => h.log.includes(dayKey(off))).length / habits.length : 0);
const velocity = (habits) => {
  let num = 0, den = 0;
  for (let i = 0; i < 14; i++) { const w = Math.pow(0.9, i); num += w * dayRatio(habits, -i); den += w; }
  return Math.round((num / den) * 100);
};
// Peak cognitive window: learned from your focus sessions, else wake time + sleep
const peakWindow = (meta) => {
  const hrs = meta.hours || {}, total = Object.values(hrs).reduce((a, b) => a + b, 0);
  const best = Object.keys(hrs).sort((a, b) => hrs[b] - hrs[a])[0];
  const sleep = sleepNow(meta) ?? 7, short = sleep < 6;
  const learned = total >= 3 && best !== undefined;
  const start = (learned ? +best : meta.wake + 2) + (short ? 1 : 0);
  return { start, end: start + (short ? 1.5 : 2), learned };
};
const parseDump = (raw) => {
  const out = { actions: [], models: [], archive: [] };
  raw.split(/\n+|[.!?]\s+/).map((x) => x.trim()).filter(Boolean).forEach((l) => {
    const clean = l.replace(/^(-|\*|\[ ?\]|todo:?|to do:?)\s*/i, '').replace(/[.!?]+$/, '');
    if (!clean) return;
    if (/\b(principle|insight|lesson|rule|framework|model|always|never|pattern|the key is)\b/i.test(l)) out.models.push(clean);
    else if (/^(-|\*|\[ ?\]|todo|to do)/i.test(l) || /\b(need to|have to|must|should|remember to|don't forget|call|email|buy|book|send|schedule|finish|fix|write|submit|pay)\b/i.test(l)) out.actions.push(clean);
    else out.archive.push(clean);
  });
  return out;
};
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

/* ---------- Extra helpers (plans, sleep, score, badges) ---------- */
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sameish = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)))); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const hm = (h) => { const t = Math.round(h * 60); return `${Math.floor(t / 60)}h ${pad(t % 60)}m`; };
const keyOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dLabel = (k) => { const d = new Date(k + 'T12:00:00'); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`; };
const timeOf = (ts) => { if (!ts) return ''; const d = new Date(ts), t = fmt(d.getHours() + d.getMinutes() / 60); return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`; };
const prunePlans = (pl) => Object.fromEntries(Object.entries(pl).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30));

const GUESS = [
  ['body', /workout|gym|run|walk|stretch|lift|exercise|yoga|meal|lunch|breakfast|dinner|protein|swim|cardio|nap/i],
  ['academics', /study|read|class|lecture|exam|homework|revise|learn|course|assignment|essay|flashcard/i],
  ['mind', /meditat|journal|breath|reflect|gratitude|reset|mindful|wind.?down/i],
  ['career', /work|project|code|coding|email|client|job|resume|portfolio|invoice|budget|income|skill|business/i],
  ['social', /call|friend|family|date|chat|meet|network|mentor|volunteer/i],
];
const guessCat = (t) => (GUESS.find(([, re]) => re.test(t)) || ['discipline'])[0];

const JOURNAL_PROMPTS = [
  'What went well today, and why?',
  'What did you avoid today, and what was the real reason?',
  'What did you learn today that you want to keep?',
  'What drained your energy? What gave you energy?',
  'What is the one thing that would make tomorrow a win?',
  'What would the best version of you have done differently today?',
  'Who helped you recently, and how can you thank them?',
];

/* Plan detection and parsing: the Coach answers with a [[plan]] JSON block that gets applied across the app. */
const PLAN_RE = /\b(?:plan(?:ning)?|schedul(?:e|ing)|organi[sz]e|time[- ]?block(?:ing)?)\s+(?:out\s+)?(?:(?:my|the|for|me|a)\s+)*(?:(?:whole|entire)\s+)?(?:day|today|tomorrow)\b/i;
const planOffset = (t) => (/\btomorrow\b/i.test(t) ? 1 : /\btoday\b/i.test(t) ? 0 : new Date().getHours() >= 21 ? 1 : 0);
const PLAN_TAG = /\[\[plan\]\]([\s\S]*?)(?:\[\[\/plan\]\]|$)/i;
const TIME_LINE = /^[\s>*\u2022-]*(?:\d+[.)]\s+)?\**\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*(?:-|\u2013|\u2014|to)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\**\s*[:|\u2013\u2014-]?\s*\**\s*(.+)$/i;

const toH = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) && x >= 0 && x <= 24 ? x : null;
  const m = String(x == null ? '' : x).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?$/i);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0, ap = m[3] && m[3].toLowerCase();
  if (mi > 59) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  const v = h + mi / 60;
  return v > 24 ? null : v;
};
const clean1 = (x, n) => String(x == null ? '' : x).replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const validCat = (c) => CATS.some((x) => x.id === c);

function normPlan(blocks, tasks, focus) {
  const seen = new Set();
  const bl = blocks.map((b) => {
    const st = toH(b.start);
    if (st === null || st >= 24) return null;
    let en = b.end != null ? toH(b.end) : null;
    if (en === null || en <= st) en = Math.min(24, st + 0.5);
    const title = clean1(b.title, 70);
    if (!title) return null;
    return { start: st, end: en, title, cat: validCat(b.cat) ? b.cat : guessCat(title), ref: clean1(b.ref, 80) };
  }).filter(Boolean).sort((a, b) => a.start - b.start)
    .filter((b) => { const k = `${b.start}|${norm(b.title)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 14);
  if (bl.length < 2) return null;
  const ts = [], tseen = new Set();
  tasks.forEach((t) => {
    const title = clean1(t.title, 80);
    if (title && !tseen.has(norm(title)) && ts.length < 4) { tseen.add(norm(title)); ts.push({ title, cat: validCat(t.cat) ? t.cat : guessCat(title) }); }
  });
  return { focus: clean1(focus, 140), blocks: bl, tasks: ts };
}

const meridian = (x) => (/[ap]/i.exec(String(x).replace(/[\d:\s.]/g, '')) || [''])[0].toLowerCase();
const textPlan = (text) => {
  const out = [];
  text.split('\n').forEach((line) => {
    const m = line.match(TIME_LINE);
    if (!m) return;
    let a = m[1], b = m[2];
    const ma = meridian(a), mb = meridian(b);
    if (!ma && mb) a += `${mb}m`; else if (ma && !mb) b += `${ma}m`;
    let st = toH(a);
    const en = toH(b);
    if (st === null || en === null) return;
    if (en <= st && !ma && mb) st -= 12;
    out.push({ start: st, end: en, title: m[3] });
  });
  return out;
};

function extractPlan(reply) {
  const m = reply.match(PLAN_TAG);
  let text = reply.replace(PLAN_TAG, '').replace(/```(?:json)?\s*```/gi, '').trim();
  const src = m ? m[1] : reply;
  const objs = (src.match(/\{[^{}]*\}/g) || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter((o) => o && o.title);
  const blocks = objs.filter((o) => o.start != null), tasks = m ? objs.filter((o) => o.start == null) : [];
  const fm = src.match(/"focus"\s*:\s*"([^"]{1,160})"/);
  let plan = blocks.length >= 2 ? normPlan(blocks, tasks, fm ? fm[1] : '') : null;
  if (plan && !m) text = text.replace(/```(?:json)?[\s\S]*?```/gi, '').trim();
  if (!plan) { const tb = textPlan(text); if (tb.length >= 3) plan = normPlan(tb, [], ''); }
  return { text: text || 'Your plan is ready.', plan };
}

const planRules = (label, date, now, off, bed) => `PLAN MODE: the user wants a plan for ${label} (${date}). ${off ? '' : `It is ${fmt(now)} now, so schedule only from now onward. `}Reply with at most 3 short coaching sentences, then output the plan in exactly this format (valid JSON, 24-hour "HH:MM" times, 6 to 12 blocks, no overlaps, between wake time and the target bedtime ${fmt(bed)}):
[[plan]]{"focus":"the one outcome that matters most","blocks":[{"start":"07:00","end":"07:45","title":"Short title","cat":"body","ref":"exact title of an existing task or habit this block completes (omit if none)"}],"tasks":[{"title":"new task worth adding","cat":"career"}]}[[/plan]]
Rules: cat is one of academics, mind, body, discipline, career, social. Put the hardest work inside the peak window. Include meals, breaks and a wind-down block before bed. Use the user's real open tasks, habits and goals, and set ref only to an exact existing title. Add at most 4 new tasks, only for important things missing from the list. Adapt to sleep: if last night was under 6 hours, do not stack heavy work early. Do not repeat the schedule in prose.`;

/* Sleep */
const sleepNow = (meta) => {
  const sl = meta.sleep || {};
  if (sl[dayKey(0)] != null) return sl[dayKey(0)];
  const r = [1, 2, 3].map((i) => sl[dayKey(-i)]).filter((v) => v != null);
  return r.length ? sum(r) / r.length : null;
};
const spreadMin = (vals) => {
  if (vals.length < 3) return null;
  const mu = sum(vals) / vals.length;
  return Math.round(Math.sqrt(sum(vals.map((v) => (v - mu) ** 2)) / vals.length) * 60);
};
const sleepInfo = (meta) => {
  const sl = meta.sleep || {}, lg = meta.sleepLog || {}, target = meta.sleepTarget || 8;
  const n7 = lastDays(7).map((d) => sl[d]).filter((v) => v != null);
  const detail = lastDays(14).map((d) => lg[d]).filter(Boolean);
  const rel = detail.map((x) => (x.bed - 18 + 24) % 24);
  const avgRel = rel.length ? sum(rel) / rel.length : null;
  const avgWake = detail.length ? sum(detail.map((x) => x.wake)) / detail.length : meta.wake;
  return {
    target, last: sl[dayKey(0)] ?? null, n7: n7.length, avg7: n7.length ? sum(n7) / n7.length : null,
    debt: sum(n7.map((v) => Math.max(0, target - v))), spread: spreadMin(rel),
    avgBed: avgRel === null ? null : (avgRel + 18) % 24, avgWake,
    bedTonight: (((avgWake - target) % 24) + 24) % 24,
  };
};
const sleepEdge = (meta, activity) => {
  const sl = meta.sleep || {}, ks = Object.keys(sl);
  const avg = (a) => (a.length ? sum(a.map((k) => activity[k] || 0)) / a.length : 0);
  const hi = ks.filter((k) => sl[k] >= 7), lo = ks.filter((k) => sl[k] < 7);
  return hi.length && lo.length ? avg(hi) - avg(lo) : null;
};

/* Day score: one number blending habits, plan or tasks, focus, water and sleep */
const dayScore = (tasks, habits, meta, plan) => {
  const t = dayKey(0), hd = habits.filter((h) => h.log.includes(t)).length;
  const doneT = tasks.filter((x) => x.done && x.doneOn === t).length, openT = tasks.filter((x) => !x.done).length;
  const pb = plan ? plan.blocks.length : 0, pd = plan ? plan.blocks.filter((b) => b.done).length : 0;
  const focus = (meta.focusDays || {})[t] || 0, water = (meta.water || {})[t] || 0, wg = meta.waterGoal || 8, sl = (meta.sleep || {})[t];
  const parts = [
    habits.length && { w: 30, v: hd / habits.length, txt: `Habits ${hd}/${habits.length}` },
    pb ? { w: 30, v: pd / pb, txt: `Plan ${pd}/${pb}` } : (doneT + openT) && { w: 30, v: doneT / (doneT + openT), txt: `Tasks ${doneT}/${doneT + openT}` },
    { w: 20, v: clamp(focus / 50), txt: `Focus ${focus}m` },
    { w: 10, v: clamp(water / wg), txt: `Water ${water}/${wg}` },
    { w: 10, v: sl == null ? 0 : clamp(sl / (meta.sleepTarget || 8)), txt: sl == null ? 'Sleep not logged' : `Sleep ${sl.toFixed(1)}h` },
  ].filter(Boolean);
  const tw = sum(parts.map((p) => p.w));
  return { score: Math.round((100 * sum(parts.map((p) => p.w * p.v))) / tw), txt: parts.map((p) => p.txt).join(' · ') };
};

/* Smart nudges: rule-based, work offline */
const nudges = ({ meta, habits, cards, plan, pk, inPeak, online }) => {
  const d = new Date(), now = d.getHours() + d.getMinutes() / 60, si = sleepInfo(meta), out = [], t = dayKey(0);
  const left = habits.filter((h) => !h.log.includes(t)).length, water = (meta.water || {})[t] || 0, wg = meta.waterGoal || 8;
  const toBed = (((si.bedTonight - now) % 24) + 24) % 24, past = (((now - si.bedTonight) % 24) + 24) % 24;
  if (meta.sleepStart) out.push({ icon: 'moon', text: 'Sleep timer is running. Open Sleep when you wake up.', go: 'sleep' });
  else if ((meta.sleep || {})[t] == null && now >= 6 && now < 14) out.push({ icon: 'bed-outline', text: `Log last night's sleep so your analytics stay accurate.`, go: 'sleep' });
  if (toBed <= 1.5) out.push({ icon: 'moon-outline', text: `Bedtime in ${Math.round(toBed * 60)} min. Start winding down.`, go: 'sleep' });
  else if (past <= 3) out.push({ icon: 'moon', text: `Past your ${fmt(si.bedTonight)} bedtime. Sleep now: tomorrow's output depends on it.`, go: 'sleep' });
  if (inPeak) out.push({ icon: 'flash', text: `You are in your peak window until ${fmt(pk.end)}. Do the hardest task now.`, go: 'focus' });
  else if (pk.start > now && pk.start - now <= 0.5) out.push({ icon: 'flash-outline', text: `Peak window starts in ${Math.round((pk.start - now) * 60)} min. Line up your hardest task.`, go: 'focus' });
  const cur = plan && plan.blocks.find((b) => !b.done && b.start <= now && now < b.end);
  if (cur) out.push({ icon: 'time-outline', text: `Now: ${cur.title} (until ${fmt(cur.end)})`, go: 'focus' });
  if (!plan && online && now < 20) out.push({ icon: 'sparkles-outline', text: 'No plan for today yet. Let Coach build one and apply it here.', go: 'plan' });
  if (left && now >= 18) out.push({ icon: 'flame-outline', text: `${left} habit${left > 1 ? 's' : ''} left today. Protect your streak.`, go: 'habits' });
  if (water < wg / 2 && now >= 14) out.push({ icon: 'water-outline', text: `Water is low: ${water}/${wg}.`, go: null });
  const due = cards.filter((c) => c.due <= t).length;
  if (due) out.push({ icon: 'albums-outline', text: `${due} flashcard${due > 1 ? 's' : ''} due for review.`, go: 'learn' });
  return out.slice(0, 2);
};

/* Badges: derived from your data, nothing extra to store except which ones were announced */
const badgeDefs = (xp, focusMin, habits, cards, meta) => {
  const sl = meta.sleep || {}, tg = meta.sleepTarget || 8, plans = Object.values(meta.plans || {}), wg = meta.waterGoal || 8;
  const best = Math.max(0, ...habits.map((h) => longest(h.log)));
  const lvl = Math.floor(xp / 100) + 1;
  return [
    { id: 'lvl2', icon: 'rocket-outline', name: 'Liftoff', desc: 'Reach level 2', cur: lvl, need: 2 },
    { id: 'lvl5', icon: 'trending-up-outline', name: 'Climber', desc: 'Reach level 5', cur: lvl, need: 5 },
    { id: 'focus5', icon: 'timer-outline', name: 'Deep Worker', desc: '5 hours of deep focus', cur: Math.floor(focusMin / 60), need: 5 },
    { id: 'focus20', icon: 'infinite-outline', name: 'Flow State', desc: '20 hours of deep focus', cur: Math.floor(focusMin / 60), need: 20 },
    { id: 'streak7', icon: 'flame-outline', name: 'On Fire', desc: '7-day habit streak', cur: best, need: 7 },
    { id: 'streak30', icon: 'shield-checkmark-outline', name: 'Unbreakable', desc: '30-day habit streak', cur: best, need: 30 },
    { id: 'sleep7', icon: 'moon-outline', name: 'Sleep Logger', desc: 'Log 7 nights of sleep', cur: Object.keys(sl).length, need: 7 },
    { id: 'rested', icon: 'bed-outline', name: 'Well Rested', desc: `5 nights of ${tg}h or more`, cur: Object.values(sl).filter((v) => v >= tg).length, need: 5 },
    { id: 'plan3', icon: 'calendar-outline', name: 'Planner', desc: 'Finish 70% of 3 daily plans', cur: plans.filter((p) => p.blocks.length && p.blocks.filter((b) => b.done).length / p.blocks.length >= 0.7).length, need: 3 },
    { id: 'water5', icon: 'water-outline', name: 'Hydrated', desc: 'Hit your water goal 5 days', cur: Object.values(meta.water || {}).filter((v) => v >= wg).length, need: 5 },
    { id: 'journal7', icon: 'book-outline', name: 'Reflective', desc: 'Write 7 journal entries', cur: (meta.journal || []).length, need: 7 },
    { id: 'cards10', icon: 'albums-outline', name: 'Memory Master', desc: 'Master 10 flashcards', cur: cards.filter((c) => c.box >= 4).length, need: 10 },
    { id: 'urge10', icon: 'hand-left-outline', name: 'Impulse Master', desc: 'Resist 10 urges', cur: meta.urges || 0, need: 10 },
    { id: 'goal1', icon: 'trophy-outline', name: 'Goal Getter', desc: 'Complete a goal', cur: (meta.goals || []).filter((g) => g.done).length, need: 1 },
  ].map((b) => ({ ...b, ok: b.cur >= b.need }));
};

const listItems = (text) => text.split('\n')
  .map((l) => l.match(/^\s*(?:[-*\u2022]|\d+[.)]|\[ ?\])\s+(.{4,120})$/))
  .filter(Boolean)
  .map((m) => m[1].replace(/\*+/g, '').replace(/[:\uFF1A]\s*$/, '').trim())
  .filter((x) => x.length >= 4)
  .slice(0, 8);

const DEFAULT_META = {
  wake: 7, lock: false, sleep: {}, sleepLog: {}, sleepStart: null, sleepTarget: 8, hours: {}, urges: 0, slips: 0,
  models: [], archive: [], focusDays: {}, focusLog: [], reviews: { ok: 0, n: 0 }, mood: {}, rt: [], span: 0,
  plans: {}, water: {}, waterGoal: 8, journal: [], goals: [], badges: [], chatKeep: 60,
};

const buildSystem = (mode, tasks, habits, profile = {}, memory = [], ctx = {}) => {
  const c = mode === 'all' ? null : catOf(mode);
  const open = tasks.filter((t) => !t.done).map((t) => `- [${t.cat}] ${t.title}${t.star ? ' (PRIORITY)' : ''}`).join('\n') || '(none)';
  const hb = habits.map((h) => `- [${h.cat}] ${h.title} (streak ${streakOf(h.log)}, done today: ${h.log.includes(dayKey(0))})`).join('\n') || '(none)';
  const me = [['Name', profile.name], ['Situation', profile.situation], ['Goals', profile.goals], ['Weaknesses', profile.weaknesses], ['Strengths', profile.strengths], ['Routine and values', profile.routine]]
    .filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v.trim()}`).join('\n') || '(not filled in yet: gently ask the user to complete their profile)';
  return `You are AutoKinetics, an elite personal coach whose mission is to make the user a genius-level, superhuman performer: smarter, stronger, more disciplined and more successful across six pillars: ${CATS.map((x) => x.name).join(', ')}. Hold them to a superhuman standard with evidence-based methods (deliberate practice, spaced repetition, sleep, progressive overload, deep work) and give honest feedback, not flattery. ${c ? `Current focus: ${c.name} (${c.focus}).` : 'Balance all six pillars.'}
Be direct, motivating and practical, never preachy. Use short checklists and time-blocked plans. Ask at most 3 short questions when you need details. For health topics give general guidance and suggest a professional for medical concerns. Never invent facts about the user.
Date: ${new Date().toString()}
Open tasks:
${open}
Habits:
${hb}
${ctx.extra || ''}
USER PROFILE (permanent memory: always use it, never ask for it again):
${me}
MEMORY FACTS:
${memory.length ? memory.map((f) => `- ${f}`).join('\n') : '(none yet)'}
When you learn a new lasting fact about the user, end your reply with [[remember: short fact]] (one tag per fact, only if genuinely new).`;
};

const API = 'https://openrouter.ai/api/v1';
let freePool = null; // cached list of currently free models
async function loadFreePool() {
  if (freePool) return freePool;
  try {
    const j = await (await fetch(`${API}/models`)).json();
    const pref = ['llama', 'qwen', 'gpt-oss', 'mistral', 'gemma', 'deepseek'];
    const rank = (id) => { const i = pref.findIndex((x) => id.includes(x)); return i < 0 ? 99 : i; };
    freePool = (j.data || [])
      .filter((m) => m.id.endsWith(':free') && !/coder|guard|embed|rerank|image/i.test(m.id) && (m.architecture?.output_modalities || ['text']).includes('text'))
      .sort((a, b) => rank(a.id) - rank(b.id) || (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id);
  } catch (e) { freePool = []; }
  return freePool;
}

async function callOnce(apiKey, model, messages, maxTokens = 1200) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://autokinetics.app', 'X-Title': 'AutoKinetics' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.ok && !data.error) {
      const text = String(data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      return text ? { text } : { status: 0, msg: 'empty' };
    }
    return { status: Number(data?.error?.code) || res.status, msg: String(data?.error?.message || '') };
  } catch (e) {
    return { status: 0, msg: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

// Tries the free router first, then falls back across currently-free models.
async function askAI(apiKey, history, system, maxTokens = 1200) {
  const turns = history.slice(-30).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const withSys = [{ role: 'system', content: system }, ...turns];
  const merged = turns.map((t, i) => (i === 0 ? { ...t, content: `${system}\n\n${t.content}` } : t));
  const attempt = async (model) => {
    let r = await callOnce(apiKey, model, withSys, maxTokens);
    if (r.status === 400) r = await callOnce(apiKey, model, merged, maxTokens); // some models reject system prompts
    if (r.status === 401) throw new Error('OpenRouter rejected your key. Re-copy it in settings (it starts with sk-or-).');
    if (r.status === 402) throw new Error('OpenRouter reports a negative balance. Free models need a balance of zero or more.');
    if (r.status === 429 && /per-day|daily/i.test(r.msg)) throw new Error('Daily free limit reached (about 50 free messages per day). It resets around 00:00 UTC.');
    if (r.status === 429 && /per-min/i.test(r.msg)) throw new Error('You hit the free limit of 20 requests per minute. Wait 30 seconds and retry.');
    return r.text;
  };
  for (const model of ['openrouter/free', 'openrouter/free']) {
    const t = await attempt(model);
    if (t) return t;
  }
  for (const model of (await loadFreePool()).slice(0, 4)) {
    const t = await attempt(model);
    if (t) return t;
  }
  throw new Error('All free models are busy right now. Wait a minute and try again.');
}

function useIsOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => NetInfo.addEventListener((s) => setOnline(s.isConnected !== false && s.isInternetReachable !== false)), []);
  return online;
}

/* ---------- Design tokens ---------- */
const C = {
  bg: '#000', surface: '#0B0B0D', raised: '#141417', border: '#2E2E33', text: '#F4F4F5', muted: '#8A8A93',
  accent: '#F4F4F5', onAccent: '#000', online: '#22C55E', offline: '#DC2626', disabled: '#3A3A3F',
};

const Icon = ({ n, size = 20, color = C.text, style }) => <Ionicons name={n} size={size} color={color} style={style} />;

function Logo() {
  return (
    <View style={s.logoRow}>
      <View style={s.logoMark}><Icon n="pulse" size={18} color={C.onAccent} /></View>
      <Text style={s.brand}>Auto<Text style={{ color: C.muted }}>Kinetics</Text></Text>
    </View>
  );
}


/* ---------- Small components ---------- */
function CatChips({ value, onChange, withAll }) {
  const list = withAll ? [{ id: 'all', name: 'All', icon: 'sparkles-outline', color: C.text }, ...CATS] : CATS;
  return (
    <View style={s.chipRow}>
      {list.map((c) => {
        const on = value === c.id;
        return (
          <Pressable key={c.id} onPress={() => onChange(c.id)} style={[s.chip, on && { borderColor: c.color, backgroundColor: C.raised }]}>
            <View style={s.btnRow}><Icon n={c.icon} size={16} color={on ? c.color : C.muted} /><Text style={[s.chipText, { marginLeft: 6 }, on && { color: c.color }]}>{c.name}</Text></View>
          </Pressable>
        );
      })}
    </View>
  );
}

function AddRow({ placeholder, onAdd }) {
  const [text, setText] = useState('');
  const submit = () => { if (text.trim()) { onAdd(text.trim()); setText(''); } };
  return (
    <View style={s.addRow}>
      <TextInput style={s.addInput} value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={C.muted}
        onSubmitEditing={submit} returnKeyType="done" keyboardAppearance="dark" />
      <Pressable onPress={submit} style={[s.addBtn, !text.trim() && { backgroundColor: C.disabled }]}>
        <Text style={s.addBtnText}>Add</Text>
      </Pressable>
    </View>
  );
}

/* ---------- Shared UI: toast with undo, confirm dialog, sub-screen shell ---------- */
function Toast({ toast, onUndo, onClose }) {
  const ins = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View style={[s.toastWrap, { bottom: 64 + ins.bottom }]} pointerEvents="box-none">
      <View style={s.toast}>
        <Text style={[s.bubbleText, { fontSize: 14, flex: 1, lineHeight: 19 }]} numberOfLines={3}>{toast.text}</Text>
        {!!toast.undo && <Pressable onPress={onUndo} hitSlop={8}><Text style={s.toastBtn}>Undo</Text></Pressable>}
        <Pressable onPress={onClose} hitSlop={8}><Icon n="close" size={16} color={C.muted} style={{ marginLeft: 12 }} /></Pressable>
      </View>
    </View>
  );
}

function Confirm({ c, onNo }) {
  return (
    <Modal visible={!!c} transparent animationType="fade" onRequestClose={onNo}>
      <View style={s.backdrop}>
        <View style={s.modal}>
          <Text style={s.h1}>{c ? c.title : ''}</Text>
          <Text style={[s.muted, { marginTop: 10 }]}>{c ? c.body : ''}</Text>
          <View style={[s.between, { marginTop: 20, justifyContent: 'flex-end' }]}>
            <Pressable style={s.ghost} onPress={onNo}><Text style={s.ghostText}>Cancel</Text></Pressable>
            <Pressable style={[s.ghost, { backgroundColor: '#B91C1C', marginLeft: 8 }]} onPress={() => { const f = c && c.yes; onNo(); if (f) f(); }}>
              <Text style={[s.ghostText, { color: '#fff' }]}>{c ? c.label : ''}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Screen({ title, sub, onBack, children }) {
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} hitSlop={10} style={[s.btnRow, { alignSelf: 'flex-start', marginBottom: 8 }]}>
        <Icon n="chevron-back" size={18} color={C.muted} /><Text style={[s.muted, { marginLeft: 2 }]}>Today</Text>
      </Pressable>
      <Text style={s.h1}>{title}</Text>
      {!!sub && <Text style={[s.muted, { marginTop: 4, marginBottom: 12 }]}>{sub}</Text>}
      {children}
    </ScrollView>
  );
}

function Stepper({ label, value, onChange }) {
  const go = (d) => onChange((((value + d) % 24) + 24) % 24);
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={s.muted}>{label}</Text>
      <View style={[s.between, { marginTop: 6 }]}>
        {[[-1, '\u22121h'], [-0.25, '\u221215m']].map(([d, l]) => <Pressable key={l} onPress={() => go(d)} style={s.stepBtn}><Text style={s.chipText}>{l}</Text></Pressable>)}
        <Text style={s.stepVal}>{fmt(value)}</Text>
        {[[0.25, '+15m'], [1, '+1h']].map(([d, l]) => <Pressable key={l} onPress={() => go(d)} style={s.stepBtn}><Text style={s.chipText}>{l}</Text></Pressable>)}
      </View>
    </View>
  );
}

/* ---------- Sleep tracker ---------- */
function Sleep({ meta, setMeta, activity, onBack }) {
  const si = sleepInfo(meta), sl = meta.sleep || {}, lg = meta.sleepLog || {};
  const prev = lastDays(14).map((d) => lg[d]).find(Boolean);
  const [bed, setBed] = useState(prev ? prev.bed : 23);
  const [wake, setWake] = useState(prev ? prev.wake : meta.wake || 7);
  const [q, setQ] = useState(3);
  const [off, setOff] = useState(0);
  const [msg, setMsg] = useState('');
  const hrs = (((wake - bed) % 24) + 24) % 24, okHrs = hrs >= 0.5 && hrs <= 16;
  const asleep = meta.sleepStart, sd = asleep ? new Date(asleep) : null;
  const save = (date, b, w, h, qual) => {
    const rw = Math.round(w * 2) / 2;
    setMeta((m) => ({
      ...m, sleepStart: null,
      sleep: { ...m.sleep, [date]: Math.round(h * 100) / 100 },
      sleepLog: { ...m.sleepLog, [date]: { bed: b, wake: w, q: qual } },
      ...(date === dayKey(0) && rw >= 3 && rw <= 12 ? { wake: rw } : {}),
    }));
  };
  const stop = () => {
    const e = (Date.now() - asleep) / 36e5, nw = new Date();
    if (e < 0.5 || e > 16) {
      setMeta((m) => ({ ...m, sleepStart: null }));
      setMsg(e < 0.5 ? 'That was under 30 minutes, so it was discarded.' : 'The timer ran over 16 hours, so it was discarded. Log the night manually below.');
      return;
    }
    save(dayKey(0), sd.getHours() + sd.getMinutes() / 60, nw.getHours() + nw.getMinutes() / 60, e, 3);
    setMsg(`Logged ${hm(e)} of sleep. You can rate its quality in the list below.`);
  };
  const logManual = () => {
    if (!okHrs) return;
    save(dayKey(-off), bed, wake, hrs, q);
    setMsg(`Saved ${hm(hrs)} for ${off ? 'yesterday' : 'last night'}.`);
  };
  const del = (d) => setMeta((m) => { const a = { ...m.sleep }, b = { ...m.sleepLog }; delete a[d]; delete b[d]; return { ...m, sleep: a, sleepLog: b }; });
  const setQual = (d, v) => setMeta((m) => ({ ...m, sleepLog: { ...m.sleepLog, [d]: { ...(m.sleepLog || {})[d], q: v } } }));
  const edge = sleepEdge(meta, activity);
  const rows = lastDays(14).filter((d) => sl[d] != null);
  const barColor = (h) => (h >= si.target ? C.online : h >= si.target - 1 ? '#FBBF24' : '#F87171');
  return (
    <Screen title="Sleep" sub="Track when you sleep. Readiness, your peak window and Coach all use this." onBack={onBack}>
      <View style={s.card}>
        {asleep ? (
          <>
            <Text style={s.muted}>Sleeping since {fmt(sd.getHours() + sd.getMinutes() / 60)}</Text>
            <Text style={s.velocity}>{hm((Date.now() - asleep) / 36e5)}</Text>
            <Pressable onPress={stop} style={[s.wide, { backgroundColor: C.accent, maxWidth: '100%', marginTop: 12 }]}><Text style={s.addBtnText}>I am awake</Text></Pressable>
            <Pressable onPress={() => setMeta((m) => ({ ...m, sleepStart: null }))} style={[s.wide, { backgroundColor: '#17171A', maxWidth: '100%', marginTop: 8 }]}><Text style={s.ghostText}>Cancel timer</Text></Pressable>
          </>
        ) : (
          <>
            <Text style={[s.habitTitle, { flex: 0 }]}>Going to bed?</Text>
            <Text style={[s.muted, { marginTop: 6 }]}>Start the timer now and open it again when you wake. Recommended bedtime tonight: {fmt(si.bedTonight)} for {si.target}h of sleep.</Text>
            <Pressable onPress={() => { setMsg(''); setMeta((m) => ({ ...m, sleepStart: Date.now() })); }} style={[s.wide, { backgroundColor: C.accent, maxWidth: '100%', marginTop: 12 }]}><Text style={s.addBtnText}>Start sleep timer</Text></Pressable>
          </>
        )}
        {!!msg && <Text style={[s.muted, { color: C.online, marginTop: 10 }]}>{msg}</Text>}
      </View>

      <View style={s.tiles}>
        <Tile label="Last night" value={si.last == null ? '\u2013' : hm(si.last)} sub={si.last == null ? 'not logged' : `target ${si.target}h`} color={si.last == null ? undefined : barColor(si.last)} />
        <Tile label="7-night avg" value={si.avg7 == null ? '\u2013' : hm(si.avg7)} sub={`${si.n7} night${si.n7 === 1 ? '' : 's'} logged`} />
        <Tile label="Sleep debt" value={`${si.debt.toFixed(1)}h`} sub="last 7 nights" color={si.debt > 5 ? '#F87171' : si.debt > 2 ? '#FBBF24' : C.online} />
        <Tile label="Avg bedtime" value={si.avgBed == null ? '\u2013' : fmt(si.avgBed)} sub="last 14 nights" />
        <Tile label="Avg wake" value={fmt(si.avgWake)} sub={prev ? 'from your logs' : 'your set wake time'} />
        <Tile label="Consistency" value={si.spread == null ? '\u2013' : `\u00B1${si.spread}m`} sub={si.spread == null ? 'needs 3 nights' : 'bedtime spread'} color={si.spread == null ? undefined : si.spread <= 30 ? C.online : si.spread <= 60 ? '#FBBF24' : '#F87171'} />
      </View>

      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Log a night manually</Text>
        <View style={[s.chipRow, { marginTop: 10 }]}>
          {[[0, 'Woke up today'], [1, 'Woke up yesterday']].map(([v, l]) => (
            <Pressable key={v} onPress={() => setOff(v)} style={[s.chip, { paddingVertical: 6 }, off === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{l}</Text></Pressable>
          ))}
        </View>
        <Stepper label="Bedtime" value={bed} onChange={setBed} />
        <Stepper label="Wake time" value={wake} onChange={setWake} />
        <Text style={[s.muted, { marginTop: 12 }]}>{okHrs ? `Total: ${hm(hrs)}` : 'Total looks off. Adjust the times (30 minutes to 16 hours).'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
          <Text style={[s.muted, { width: 70 }]}>Quality</Text>
          {[1, 2, 3, 4, 5].map((v) => <Pressable key={v} onPress={() => setQ(v)} style={[s.mini, q === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{v}</Text></Pressable>)}
        </View>
        <Pressable disabled={!okHrs} onPress={logManual} style={[s.wide, { backgroundColor: okHrs ? C.accent : C.disabled, maxWidth: '100%', marginTop: 14 }]}><Text style={s.addBtnText}>Save sleep</Text></Pressable>
      </View>

      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Last 14 nights</Text>
        <View style={s.bars}>
          {Array.from({ length: 14 }, (_, i) => 13 - i).map((i) => {
            const d = dayKey(-i), h = sl[d], dt = new Date(d + 'T12:00:00');
            return (
              <View key={d} style={s.barCol}>
                <Text style={[s.barLbl, { fontSize: 9 }]}>{h != null ? h.toFixed(1) : ''}</Text>
                <View style={[s.bar, { width: 10, height: h != null ? 4 + Math.min(h, 10) * 7.6 : 4, backgroundColor: h != null ? barColor(h) : '#2A2A2E' }]} />
                <Text style={s.barLbl}>{'SMTWTFS'[dt.getDay()]}</Text>
              </View>
            );
          })}
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>Green meets your {si.target}h target, amber is within an hour, red is short.</Text>
        <Text style={[s.muted, { marginTop: 10 }]}>
          {edge === null ? 'Log nights under and over 7 hours to see how sleep changes your output.'
            : `On nights with 7+ hours you complete ${Math.abs(edge).toFixed(1)} ${edge >= 0 ? 'more' : 'fewer'} wins per day than on shorter nights.`}
        </Text>
      </View>

      <Text style={s.section}>History</Text>
      {rows.length === 0 && <Text style={s.empty}>No nights logged yet. Start the timer tonight or log last night above.</Text>}
      {rows.map((d) => (
        <View key={d} style={s.item}>
          <View style={{ flex: 1 }}>
            <Text style={[s.itemText, { flex: 0 }]}>{dLabel(d)} · {hm(sl[d])}</Text>
            <Text style={s.muted}>{lg[d] ? `${fmt(lg[d].bed)} to ${fmt(lg[d].wake)}` : 'Quick log (no times)'}</Text>
            {!!lg[d] && (
              <View style={{ flexDirection: 'row', marginTop: 4 }}>
                {[1, 2, 3, 4, 5].map((v) => <Pressable key={v} onPress={() => setQual(d, v)} hitSlop={4}><Icon n={v <= (lg[d].q || 0) ? 'star' : 'star-outline'} size={16} color="#FBBF24" style={{ marginRight: 3 }} /></Pressable>)}
              </View>
            )}
          </View>
          <Pressable onPress={() => del(d)} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
        </View>
      ))}
    </Screen>
  );
}

/* ---------- Goals ---------- */
function Goals({ meta, setMeta, onXp, onBack }) {
  const goals = meta.goals || [];
  const [title, setTitle] = useState(''), [target, setTarget] = useState('10'), [cat, setCat] = useState('discipline');
  const add = () => {
    if (!title.trim()) return;
    const n = Math.max(1, Math.min(10000, parseInt(target, 10) || 1));
    setMeta((m) => ({ ...m, goals: [{ id: uid(), title: title.trim(), cat, target: n, current: 0, done: false }, ...(m.goals || [])] }));
    setTitle('');
  };
  const step = (g, d) => {
    const cur = Math.max(0, Math.min(g.target, g.current + d));
    if (cur === g.current) return;
    const done = cur >= g.target;
    setMeta((m) => ({ ...m, goals: (m.goals || []).map((x) => (x.id === g.id ? { ...x, current: cur, done } : x)) }));
    if (done && !g.done) onXp(25);
    if (!done && g.done) onXp(-25);
  };
  return (
    <Screen title="Goals" sub="Big targets with a number. Finishing one earns 25 XP and Coach knows about every open goal." onBack={onBack}>
      <TextInput style={[s.addInput, { marginBottom: 8 }]} value={title} onChangeText={setTitle} placeholder="Goal (e.g. Read 12 books)" placeholderTextColor={C.muted} keyboardAppearance="dark" />
      <View style={s.addRow}>
        <TextInput style={s.addInput} value={target} onChangeText={setTarget} keyboardType="number-pad" placeholder="Target number" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={add} />
        <Pressable onPress={add} style={[s.addBtn, !title.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable>
      </View>
      <CatChips value={cat} onChange={setCat} />
      {goals.length === 0 && <Text style={s.empty}>No goals yet. Pick something measurable.</Text>}
      {goals.map((g) => {
        const c = catOf(g.cat), inc = g.target <= 20 ? 1 : Math.round(g.target / 10);
        return (
          <View key={g.id} style={s.card}>
            <View style={s.between}>
              <View style={[s.btnRow, { flex: 1, justifyContent: 'flex-start' }]}><Icon n={g.done ? 'trophy' : c.icon} size={20} color={g.done ? '#FBBF24' : c.color} /><Text style={[s.habitTitle, { marginLeft: 8 }]}>{g.title}</Text></View>
              <Pressable onPress={() => setMeta((m) => ({ ...m, goals: (m.goals || []).filter((x) => x.id !== g.id) }))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
            </View>
            <View style={s.track}><View style={[s.fill, { width: `${(g.current / g.target) * 100}%`, backgroundColor: g.done ? '#FBBF24' : c.color }]} /></View>
            <View style={s.between}>
              <Text style={s.muted}>{g.current} / {g.target}{g.done ? ' · done' : ''}</Text>
              <View style={s.btnRow}>
                <Pressable onPress={() => step(g, -inc)} style={s.stepBtn} hitSlop={6}><Text style={s.chipText}>{'\u2212'}{inc}</Text></Pressable>
                <Pressable onPress={() => step(g, inc)} style={[s.stepBtn, { marginLeft: 8, backgroundColor: C.accent }]} hitSlop={6}><Text style={[s.chipText, { color: C.onAccent, fontWeight: '700' }]}>+{inc}</Text></Pressable>
              </View>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

/* ---------- Journal ---------- */
function Journal({ meta, setMeta, onSave, onBack }) {
  const list = meta.journal || [];
  const [text, setText] = useState('');
  const prompt = JOURNAL_PROMPTS[new Date().getDate() % JOURNAL_PROMPTS.length];
  const days = new Set(list.map((j) => j.date));
  let streak = 0, off = days.has(dayKey(0)) ? 0 : -1;
  while (days.has(dayKey(off))) { streak++; off--; }
  const save = () => { if (!text.trim()) return; onSave(text.trim(), prompt); setText(''); };
  return (
    <Screen title="Journal" sub={`${list.length} entr${list.length === 1 ? 'y' : 'ies'} · ${streak} day streak. The first entry each day earns 5 XP.`} onBack={onBack}>
      <View style={s.card}>
        <Text style={s.muted}>Today's prompt</Text>
        <Text style={[s.bigQ, { fontSize: 19, lineHeight: 25, marginTop: 6 }]}>{prompt}</Text>
      </View>
      <TextInput style={[s.addInput, { minHeight: 130, textAlignVertical: 'top' }]} value={text} onChangeText={setText} multiline placeholder="Write freely. This stays on your device." placeholderTextColor={C.muted} keyboardAppearance="dark" />
      <Pressable onPress={save} style={[s.wide, { backgroundColor: text.trim() ? C.accent : C.disabled, maxWidth: '100%', marginTop: 10 }]}><Text style={s.addBtnText}>Save entry</Text></Pressable>
      <Text style={s.section}>Past entries</Text>
      {list.length === 0 && <Text style={s.empty}>Nothing written yet.</Text>}
      {list.slice(0, 30).map((j) => (
        <View key={j.id} style={s.card}>
          <View style={s.between}>
            <Text style={s.muted}>{dLabel(j.date)} · {timeOf(j.ts)}</Text>
            <Pressable onPress={() => setMeta((m) => ({ ...m, journal: (m.journal || []).filter((x) => x.id !== j.id) }))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
          </View>
          {!!j.prompt && <Text style={[s.muted, { fontSize: 12, marginTop: 6 }]}>{j.prompt}</Text>}
          <Text style={[s.bubbleText, { marginTop: 6 }]}>{j.text}</Text>
        </View>
      ))}
    </Screen>
  );
}

/* ---------- Badges ---------- */
function Badges({ list, onBack }) {
  const n = list.filter((b) => b.ok).length;
  return (
    <Screen title="Badges" sub={`${n} of ${list.length} unlocked. They unlock from your real activity.`} onBack={onBack}>
      {list.map((b) => (
        <View key={b.id} style={[s.item, !b.ok && { opacity: 0.75 }]}>
          <View style={[s.bigIconWrap, { width: 46, height: 46, borderRadius: 23, marginBottom: 0, marginRight: 12 }, b.ok && { borderColor: '#FBBF24' }]}>
            <Icon n={b.icon} size={22} color={b.ok ? '#FBBF24' : C.muted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.habitTitle, { flex: 0 }]}>{b.name}</Text>
            <Text style={s.muted}>{b.desc}</Text>
            <View style={[s.track, { marginVertical: 6 }]}><View style={[s.fill, { width: `${Math.min(100, (b.cur / b.need) * 100)}%`, backgroundColor: b.ok ? '#FBBF24' : C.muted }]} /></View>
            <Text style={[s.muted, { fontSize: 12 }]}>{b.ok ? 'Unlocked' : `${b.cur} / ${b.need}`}</Text>
          </View>
        </View>
      ))}
    </Screen>
  );
}

/* ---------- Weekly review ---------- */
function Review({ habits, activity, meta, online, onBack, onAnalyze }) {
  const r = useMemo(() => {
    const d7 = lastDays(7), p7 = lastDays(14).slice(7), fd = meta.focusDays || {}, si = sleepInfo(meta);
    const wins = sum(d7.map((d) => activity[d] || 0)), prevWins = sum(p7.map((d) => activity[d] || 0));
    const f7 = sum(d7.map((d) => fd[d] || 0)), fp = sum(p7.map((d) => fd[d] || 0));
    const hrate = habits.length ? Math.round((100 * sum(d7.map((d) => habits.filter((h) => h.log.includes(d)).length))) / (7 * habits.length)) : null;
    const best = d7.slice().sort((a, b) => (activity[b] || 0) - (activity[a] || 0))[0];
    const cnt = (h) => h.log.filter((d) => d7.includes(d)).length;
    const top = habits.slice().sort((a, b) => cnt(b) - cnt(a))[0];
    const plans = d7.map((d) => (meta.plans || {})[d]).filter(Boolean);
    const pb = sum(plans.map((p) => p.blocks.length)), pd = sum(plans.map((p) => p.blocks.filter((b) => b.done).length));
    const water = d7.filter((d) => ((meta.water || {})[d] || 0) >= (meta.waterGoal || 8)).length;
    const jr = (meta.journal || []).filter((j) => d7.includes(j.date)).length;
    const lines = [
      ['Wins', `${wins} (${wins - prevWins >= 0 ? '+' : ''}${wins - prevWins} vs last week)`],
      ['Deep focus', `${f7} min${fp ? ` (${f7 >= fp ? '+' : ''}${Math.round(((f7 - fp) / fp) * 100)}% vs last week)` : ''}`],
      ['Habit completion', hrate === null ? 'no habits yet' : `${hrate}%`],
      ['Sleep', si.avg7 === null ? 'not logged' : `${hm(si.avg7)} avg, ${si.debt.toFixed(1)}h debt${si.spread === null ? '' : `, bedtime \u00B1${si.spread} min`}`],
      ['Plan follow-through', pb ? `${Math.round((100 * pd) / pb)}% of ${pb} blocks` : 'no plans yet'],
      ['Water goal', `${water} of 7 days`],
      ['Journal entries', String(jr)],
      ['Best day', wins > 0 ? `${dLabel(best)} (${activity[best] || 0} wins)` : 'n/a'],
      ['Top habit', top && cnt(top) > 0 ? `${top.title} (${cnt(top)}/7)` : 'n/a'],
    ];
    return { lines };
  }, [habits, activity, meta]);
  const text = `AutoKinetics weekly review\n${r.lines.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  const [msg, setMsg] = useState('');
  const share = async () => { try { await Share.share({ message: text }); } catch (e) { setMsg('Sharing is not available here.'); } };
  return (
    <Screen title="Weekly review" sub="Your last 7 days against the 7 before. Works offline." onBack={onBack}>
      <View style={s.card}>
        {r.lines.map(([k, v]) => (
          <View key={k} style={[s.between, { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border }]}>
            <Text style={s.muted}>{k}</Text>
            <Text style={[s.bubbleText, { fontSize: 14, flexShrink: 1, textAlign: 'right', marginLeft: 12 }]}>{v}</Text>
          </View>
        ))}
      </View>
      <Pressable disabled={!online} onPress={() => onAnalyze(`Run my weekly review. Here are my numbers for the last 7 days:\n${r.lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\nName what worked, my 3 biggest bottlenecks, and one concrete experiment for each next week.`)} style={[s.wide, { backgroundColor: C.accent, maxWidth: '100%', opacity: online ? 1 : 0.4 }]}>
        <View style={s.btnRow}><Icon n="sparkles-outline" size={18} color={C.onAccent} /><Text style={[s.addBtnText, { marginLeft: 8 }]}>{online ? 'AI weekly review' : 'AI review needs a connection'}</Text></View>
      </Pressable>
      <Pressable onPress={share} style={[s.wide, { backgroundColor: '#17171A', maxWidth: '100%', marginTop: 8 }]}>
        <View style={s.btnRow}><Icon n="share-outline" size={18} /><Text style={[s.ghostText, { marginLeft: 8 }]}>Share this report</Text></View>
      </Pressable>
      {!!msg && <Text style={[s.empty, { color: '#F87171' }]}>{msg}</Text>}
    </Screen>
  );
}

/* ---------- Today ---------- */
function PlanCard({ plan, online, busy, onToggle, onClear, onReplan }) {
  const d = new Date(), now = d.getHours() + d.getMinutes() / 60;
  const done = plan.blocks.filter((b) => b.done).length;
  return (
    <View style={s.card}>
      <View style={s.between}>
        <View style={s.btnRow}><Icon n="calendar-outline" size={16} color={C.muted} /><Text style={[s.muted, { marginLeft: 6 }]}>Today's plan · {done}/{plan.blocks.length} done</Text></View>
        <Pressable onPress={onClear} hitSlop={10}><Text style={s.muted}>Clear</Text></Pressable>
      </View>
      {!!plan.focus && <Text style={[s.habitTitle, { flex: 0, marginTop: 10 }]}>The one thing: {plan.focus}</Text>}
      <View style={s.track}><View style={[s.fill, { width: `${(done / plan.blocks.length) * 100}%`, backgroundColor: C.online }]} /></View>
      {plan.blocks.map((b) => {
        const c = catOf(b.cat), cur = !b.done && b.start <= now && now < b.end;
        return (
          <Pressable key={b.id} onPress={() => onToggle(b.id)} style={[s.planRow, cur && { borderColor: C.accent }]}>
            <View style={[s.check, { borderColor: c.color }, b.done && { backgroundColor: c.color }]}>{b.done && <Icon n="checkmark" size={16} color="#000" />}</View>
            <View style={{ flex: 1 }}>
              <Text style={[s.itemText, { flex: 0 }, b.done && s.done]}>{b.title}</Text>
              <Text style={s.muted}>{fmt(b.start)} – {fmt(b.end)}{cur ? ' · now' : ''}{b.taskId || b.habitId ? ' · linked' : ''}</Text>
            </View>
            <Icon n={c.icon} size={18} color={c.color} />
          </Pressable>
        );
      })}
      <Pressable disabled={!online || busy} onPress={onReplan} style={[s.logBtn, { alignSelf: 'flex-start', marginTop: 8 }, (!online || busy) && { opacity: 0.4 }]}>
        <Text style={s.logText}>{busy ? 'Coach is planning…' : 'Replan with Coach'}</Text>
      </Pressable>
    </View>
  );
}

const TOOLS = [['sleep', 'moon-outline', 'Sleep'], ['journal', 'book-outline', 'Journal'], ['goals', 'trophy-outline', 'Goals'], ['badges', 'ribbon-outline', 'Badges'], ['review', 'document-text-outline', 'Review']];

function Today({
  name, tasks, habits, xp, online, busy, activity, focusMin, meta, setMeta, pk, inPeak, plan, tomorrowPlan, score, nudgeList,
  onOpen, onUrge, onToggle, onAdd, onDelete, onPlan, onStar, onRepeat, onClearDone, onToggleBlock, onClearPlan, onWater,
}) {
  const [cat, setCat] = useState('all');
  const [rep, setRep] = useState('');
  const lvl = Math.floor(xp / 100) + 1, into = xp % 100;
  const rank = RANKS[Math.min(lvl - 1, RANKS.length - 1)];
  const today = dayKey(0), hr = new Date().getHours();
  const shown = tasks.filter((t) => cat === 'all' || t.cat === cat).sort((a, b) => a.done - b.done || (b.star ? 1 : 0) - (a.star ? 1 : 0));
  const doneN = tasks.filter((t) => t.done).length;
  const pillars = CATS.map((c) => {
    const ts = tasks.filter((t) => t.cat === c.id), hs = habits.filter((h) => h.cat === c.id);
    return { c, total: ts.length + hs.length, done: ts.filter((t) => t.done).length + hs.filter((h) => h.log.includes(today)).length };
  });
  const water = (meta.water || {})[today] || 0, wg = meta.waterGoal || 8;
  const hello = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const go = (g) => (g === 'plan' ? onPlan() : g ? onOpen(g) : null);
  const scoreColor = score.score >= 70 ? C.online : score.score >= 40 ? '#FBBF24' : '#F87171';
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <Text style={s.h1}>{hello}{name ? `, ${name}` : ''}</Text>
        <View style={[s.between, { marginTop: 8 }]}>
          <Text style={s.muted}>Day score</Text>
          <Text style={[s.h1, { fontSize: 34, color: scoreColor }]}>{score.score}</Text>
        </View>
        <View style={s.track}><View style={[s.fill, { width: `${score.score}%`, backgroundColor: scoreColor }]} /></View>
        <Text style={[s.muted, { fontSize: 12 }]}>{score.txt}</Text>
      </View>

      {nudgeList.map((n, i) => (
        <Pressable key={i} onPress={() => go(n.go)} style={[s.item, { marginBottom: 8 }]}>
          <Icon n={n.icon} size={18} color={C.accent} style={{ marginRight: 10 }} />
          <Text style={[s.itemText, { fontSize: 14 }]}>{n.text}</Text>
          {!!n.go && <Icon n="chevron-forward" size={16} color={C.muted} />}
        </Pressable>
      ))}

      {plan ? <PlanCard plan={plan} online={online} busy={busy} onToggle={onToggleBlock} onClear={onClearPlan} onReplan={onPlan} /> : null}
      {!plan && tomorrowPlan ? <Text style={[s.muted, { marginBottom: 12 }]}>Tomorrow's plan is ready ({tomorrowPlan.blocks.length} blocks). It shows up here once the day starts.</Text> : null}

      <View style={s.toolRow}>
        {TOOLS.map(([id, ic, label]) => (
          <Pressable key={id} onPress={() => onOpen(id)} style={s.tool}><Icon n={ic} size={22} /><Text style={[s.tabLabel, { color: C.text }]}>{label}</Text></Pressable>
        ))}
      </View>

      <PeakCard meta={meta} setMeta={setMeta} pk={pk} inPeak={inPeak} onSleep={() => onOpen('sleep')} />

      <View style={s.card}>
        <View style={s.between}>
          <View style={s.btnRow}><Icon n="water-outline" size={18} color="#60A5FA" /><Text style={[s.habitTitle, { flex: 0, marginLeft: 8 }]}>Water {water}/{wg}</Text></View>
          <View style={s.btnRow}>
            <Pressable onPress={() => onWater(-1)} style={s.stepBtn} hitSlop={6}><Icon n="remove" size={18} /></Pressable>
            <Pressable onPress={() => onWater(1)} style={[s.stepBtn, { marginLeft: 8, backgroundColor: C.accent }]} hitSlop={6}><Icon n="add" size={18} color={C.onAccent} /></Pressable>
          </View>
        </View>
        <View style={[s.chipRow, { marginTop: 10 }]}>
          {Array.from({ length: Math.max(wg, water) }, (_, i) => <View key={i} style={[s.glass, i < water && { backgroundColor: '#60A5FA', borderColor: '#60A5FA' }]} />)}
        </View>
      </View>

      <View style={s.card}>
        <View style={s.between}>
          <Text style={s.h1}>Level {lvl}</Text>
          <Text style={s.rank}>{rank}</Text>
        </View>
        <View style={s.track}><View style={[s.fill, { width: `${into}%`, backgroundColor: C.accent }]} /></View>
        <Text style={s.muted}>{into}/100 XP to level {lvl + 1}. Tasks earn 10 XP, habit check-ins earn 5.</Text>
      </View>

      <View style={s.pillarRow}>
        {pillars.map(({ c, total, done }) => (
          <View key={c.id} style={s.pillar}>
            <Icon n={c.icon} size={22} color={c.color} />
            <View style={s.track}><View style={[s.fill, { width: `${total ? (done / total) * 100 : 0}%`, backgroundColor: c.color }]} /></View>
            <Text style={s.pillarText}>{done}/{total}</Text>
          </View>
        ))}
      </View>

      <View style={[s.card, { marginTop: 12, marginBottom: 0 }]}>
        <Text style={s.muted}>Last 7 days of wins · {focusMin} focus minutes total</Text>
        <View style={s.bars}>
          {[6, 5, 4, 3, 2, 1, 0].map((i) => {
            const d = new Date(); d.setDate(d.getDate() - i);
            const n = activity[dayKey(-i)] || 0;
            return (
              <View key={i} style={s.barCol}>
                <Text style={s.barLbl}>{n}</Text>
                <View style={[s.bar, { height: 6 + Math.min(n, 10) * 6, backgroundColor: i === 0 ? C.accent : '#3A3A3F' }]} />
                <Text style={s.barLbl}>{'SMTWTFS'[d.getDay()]}</Text>
              </View>
            );
          })}
        </View>
      </View>

      <Pressable onPress={onUrge} style={[s.planBtn, { borderColor: '#5B1F1F' }]}>
        <View style={s.btnRow}><Icon n="hand-left-outline" size={18} color="#F87171" /><Text style={[s.planText, { marginLeft: 8 }]}>Urge to scroll? Pause first ({meta.urges} resisted)</Text></View>
      </Pressable>
      <Pressable disabled={!online || busy} onPress={onPlan} style={[s.planBtn, (!online || busy) && { opacity: 0.4 }]}>
        <View style={s.btnRow}><Icon n="sparkles-outline" size={18} /><Text style={[s.planText, { marginLeft: 8 }]}>{busy ? 'Coach is planning your day…' : online ? 'Ask Coach to plan my day' : 'Coach planning needs a connection'}</Text></View>
      </Pressable>

      <View style={[s.between, { marginTop: 24, marginBottom: 12 }]}>
        <Text style={[s.section, { marginTop: 0, marginBottom: 0 }]}>Tasks</Text>
        {doneN > 0 && <Pressable onPress={onClearDone} hitSlop={10}><Text style={s.muted}>Clear {doneN} done</Text></Pressable>}
      </View>
      <CatChips value={cat} onChange={setCat} withAll />
      <AddRow placeholder={`Add a ${cat === 'all' ? 'Discipline' : catOf(cat).name} task`} onAdd={(t) => onAdd(t, cat === 'all' ? 'discipline' : cat, rep)} />
      <View style={[s.chipRow, { marginTop: -4 }]}>
        {[['', 'No repeat'], ['daily', 'Repeat daily'], ['weekly', 'Repeat weekly']].map(([v, l]) => (
          <Pressable key={v || 'none'} onPress={() => setRep(v)} style={[s.chip, { paddingVertical: 5 }, rep === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={[s.chipText, { fontSize: 13 }]}>{l}</Text></Pressable>
        ))}
      </View>
      {shown.length === 0 && <Text style={s.empty}>Nothing here yet. Add one small task you can finish today.</Text>}
      {shown.map((t) => {
        const c = catOf(t.cat);
        return (
          <View key={t.id} style={s.item}>
            <Pressable onPress={() => onToggle(t.id)} style={[s.check, { borderColor: c.color }, t.done && { backgroundColor: c.color }]}>
              {t.done && <Icon n="checkmark" size={16} color="#000" />}
            </Pressable>
            <Text style={[s.itemText, t.done && s.done]}>{t.title}</Text>
            {!!t.repeat && (
              <Pressable onPress={() => onRepeat(t.id)} hitSlop={8} style={s.btnRow}>
                <Icon n="repeat" size={15} color="#60A5FA" style={{ marginLeft: 6 }} /><Text style={{ color: '#60A5FA', fontSize: 11, marginLeft: 3 }}>{t.repeat}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => onStar(t.id)} hitSlop={8}><Icon n={t.star ? 'star' : 'star-outline'} size={18} color={t.star ? '#FBBF24' : C.muted} style={{ marginLeft: 8 }} /></Pressable>
            <Icon n={c.icon} size={18} color={c.color} style={{ marginHorizontal: 10 }} />
            <Pressable onPress={() => onDelete(t.id)} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

/* ---------- Habits ---------- */
function Habits({ habits, onToggle, onAdd, onDelete }) {
  const [cat, setCat] = useState('discipline');
  const today = dayKey(0);
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Habits</Text>
      <MomentumCard habits={habits} />
      <Text style={[s.muted, { marginBottom: 14 }]}>Small actions, repeated daily, become who you are. Protect your streak.</Text>
      <CatChips value={cat} onChange={setCat} />
      <AddRow placeholder={`New ${catOf(cat).name} habit (e.g. Read 20 pages)`} onAdd={(t) => onAdd(t, cat)} />
      {habits.length === 0 && <Text style={s.empty}>No habits yet. Start with one you can do in under 5 minutes.</Text>}
      {habits.map((h) => {
        const c = catOf(h.cat), doneToday = h.log.includes(today);
        return (
          <View key={h.id} style={s.card}>
            <View style={s.between}>
              <View style={[s.btnRow, { flex: 1, justifyContent: 'flex-start' }]}><Icon n={c.icon} size={20} color={c.color} /><Text style={[s.habitTitle, { marginLeft: 8 }]}>{h.title}</Text></View>
              <Pressable onPress={() => onDelete(h.id)} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
            </View>
            <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>Best streak {longest(h.log)}d · 30-day rate {Math.round((100 * h.log.filter((d) => lastDays(30).includes(d)).length) / 30)}% · {h.log.length} total check-ins</Text>
            <View style={[s.between, { marginTop: 12 }]}>
              <View style={{ flexDirection: 'row' }}>
                {[6, 5, 4, 3, 2, 1, 0].map((i) => (
                  <View key={i} style={[s.dot, h.log.includes(dayKey(-i)) && { backgroundColor: c.color, borderColor: c.color }]} />
                ))}
                <Icon n="flame" size={15} color="#FB923C" style={{ marginLeft: 8, marginRight: 3 }} /><Text style={s.muted}>{streakOf(h.log)} day streak</Text>
              </View>
              <Pressable onPress={() => onToggle(h.id)} style={[s.logBtn, doneToday && { backgroundColor: c.color, borderColor: c.color }]}>
                <Text style={[s.logText, doneToday && { color: '#000' }]}>{doneToday ? 'Done' : 'Check in'}</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

/* ---------- Friction shield, quiz, peak, momentum ---------- */
function Shield({ visible, context, onChoose }) {
  const [n, setN] = useState(7);
  useEffect(() => {
    if (!visible) return;
    setN(7);
    const t = setInterval(() => setN((x) => (x > 0 ? x - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [visible]);
  const off = n > 0;
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={s.backdrop}>
        <View style={[s.modal, { alignItems: 'center' }]}>
          <View style={s.bigIconWrap}><Icon n="hand-left-outline" size={32} color="#F87171" /></View>
          <Text style={s.h1}>Pause.</Text>
          <Text style={[s.muted, { textAlign: 'center', marginVertical: 10 }]}>{context}</Text>
          <Text style={[s.habitTitle, { textAlign: 'center', flex: 0 }]}>Is this asset-building or dopamine-chasing?</Text>
          <Text style={s.count}>{off ? n : '·'}</Text>
          <Pressable disabled={off} onPress={() => onChoose(true)} style={[s.wide, { backgroundColor: off ? C.disabled : C.accent }]}>
            <Text style={s.addBtnText}>Asset-building</Text>
          </Pressable>
          <Pressable disabled={off} onPress={() => onChoose(false)} style={[s.wide, { backgroundColor: '#17171A', marginTop: 8 }]}>
            <Text style={[s.ghostText, off && { color: C.disabled }]}>Dopamine-chasing</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function MicroQuiz({ card, onRate, onClose }) {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(false), [card && card.id]);
  return (
    <Modal visible={!!card} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.modal}>
          <View style={s.between}><View style={s.btnRow}><Icon n="albums-outline" size={16} color={C.muted} /><Text style={[s.muted, { marginLeft: 6 }]}>Quick recall</Text></View><Pressable onPress={onClose} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
          <Text style={s.bigQ}>{card ? card.q : ''}</Text>
          {show && card ? <Text style={[s.itemText, { marginTop: 14 }]}>{card.a}</Text> : null}
          {!show ? (
            <Pressable onPress={() => setShow(true)} style={[s.wide, { backgroundColor: C.accent, marginTop: 20 }]}><Text style={s.addBtnText}>Show answer</Text></Pressable>
          ) : (
            <View style={[s.between, { marginTop: 20 }]}>
              <Pressable onPress={() => onRate(card.id, false)} style={[s.ghost, { flex: 1, marginRight: 8, alignItems: 'center' }]}><Text style={s.ghostText}>Missed it</Text></Pressable>
              <Pressable onPress={() => onRate(card.id, true)} style={[s.ghost, { flex: 1, backgroundColor: C.accent, alignItems: 'center' }]}><Text style={[s.ghostText, { color: C.onAccent }]}>Got it (+2 XP)</Text></Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function PeakCard({ meta, setMeta, pk, inPeak, onSleep }) {
  const d = new Date(), now = d.getHours() + d.getMinutes() / 60;
  const mins = Math.round((pk.start - now) * 60);
  const status = inPeak ? 'You are in your peak. Heavy tasks only, no scrolling.'
    : mins > 0 ? `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m. Line up your hardest task.`
    : 'Window closed. Use the rest of the day for light tasks and admin.';
  const sl = (meta.sleep || {})[dayKey(0)];
  return (
    <View style={[s.card, inPeak && { borderColor: C.accent }]}>
      <View style={[s.btnRow, { justifyContent: 'flex-start' }]}><Icon n="flash-outline" size={16} color={C.muted} /><Text style={[s.muted, { marginLeft: 6 }]}>Peak cognitive window</Text></View>
      <Text style={s.h1}>{fmt(pk.start)} – {fmt(pk.end)}</Text>
      <Text style={[s.muted, { marginTop: 4 }]}>{status}</Text>
      <Pressable onPress={onSleep} style={[s.between, { marginTop: 12 }]}>
        <View style={[s.btnRow, { flex: 1, justifyContent: 'flex-start' }]}>
          <Icon n="moon-outline" size={16} color={C.muted} />
          <Text style={[s.muted, { marginLeft: 6, flex: 1 }]}>{meta.sleepStart ? 'Sleep timer running. Tap when you wake.' : sl == null ? 'Sleep not logged yet. Tap to log it.' : `Slept ${hm(sl)} last night`}</Text>
        </View>
        <Icon n="chevron-forward" size={16} color={C.muted} />
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
        <Text style={[s.muted, { width: 110 }]}>Wake time (am)</Text>
        {[5, 6, 7, 8, 9].map((v) => (
          <Pressable key={v} onPress={() => setMeta((m) => ({ ...m, wake: v }))} style={[s.mini, Math.round(meta.wake) === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{v}</Text></Pressable>
        ))}
      </View>
      <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>{pk.learned ? 'Learned from when you actually finish focus sessions.' : 'Estimated from your wake time and sleep. Learns your real peak after 3 focus sessions.'}</Text>
      <Pressable onPress={() => setMeta((m) => ({ ...m, lock: !m.lock }))} style={[s.logBtn, { alignSelf: 'flex-start', marginTop: 10 }, meta.lock && { borderColor: C.accent }]}>
        <View style={s.btnRow}><Icon n={meta.lock ? 'lock-closed' : 'lock-open-outline'} size={14} /><Text style={[s.logText, { marginLeft: 6 }]}>Peak Lock: {meta.lock ? 'ON' : 'OFF'}</Text></View>
      </Pressable>
    </View>
  );
}

function Gate({ end, onFocus, onOverride }) {
  return (
    <View style={s.gate}>
      <View style={s.bigIconWrap}><Icon n="lock-closed-outline" size={32} /></View>
      <Text style={s.h1}>Peak window locked</Text>
      <Text style={[s.muted, { textAlign: 'center', marginVertical: 12, maxWidth: 380 }]}>Heavy work only until {end}. This unlocks by itself. Locks apply inside AutoKinetics only.</Text>
      <Pressable onPress={onFocus} style={[s.wide, { backgroundColor: C.accent, maxWidth: 300 }]}><Text style={s.addBtnText}>Start deep focus</Text></Pressable>
      <Pressable onPress={onOverride} style={[s.wide, { backgroundColor: '#17171A', marginTop: 8, maxWidth: 300 }]}><Text style={s.ghostText}>Override</Text></Pressable>
    </View>
  );
}

function MomentumCard({ habits }) {
  const m = useMemo(() => {
    const n = habits.length, today = dayKey(0);
    const any = habits.some((h) => h.log.some((d) => d !== today));
    const recovery = any && n > 0 && dayRatio(habits, -1) < 0.5;
    const needed = recovery ? Math.ceil(n / 2) : n;
    return { n, vel: velocity(habits), recovery, needed, done: habits.filter((h) => h.log.includes(today)).length, grid: Array.from({ length: 28 }, (_, i) => dayRatio(habits, -(27 - i))) };
  }, [habits]);
  return (
    <View style={s.card}>
      <View style={s.between}>
        <View>
          <Text style={s.muted}>Consistency Velocity</Text>
          <Text style={s.velocity}>{m.vel}</Text>
        </View>
        <View style={s.grid}>
          {m.grid.map((r, i) => <View key={i} style={[s.px, { backgroundColor: r ? `rgba(52,211,153,${(0.15 + 0.85 * r).toFixed(2)})` : '#1A1A1E' }]} />)}
        </View>
      </View>
      <Text style={[s.muted, { marginTop: 10 }]}>
        {m.n === 0 ? 'Add habits to start building momentum.'
          : m.recovery ? `Never miss twice: today only needs ${m.needed} of ${m.n} habits to protect your momentum. ${m.done >= m.needed ? 'Target met' : `${m.done}/${m.needed} done.`}`
          : `Today's target: ${m.done}/${m.n}. Missing one day costs little. Missing two compounds.`}
      </Text>
    </View>
  );
}

/* ---------- Learn (spaced repetition) ---------- */
function Learn({ cards, setCards, online, apiKey, onReview, onOpenSettings }) {
  const [q, setQ] = useState(''), [a, setA] = useState(''), [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const due = cards.filter((c) => c.due <= dayKey(0)).length;
  const add = () => {
    if (!q.trim() || !a.trim()) return;
    setCards((cs) => [{ id: uid(), q: q.trim(), a: a.trim(), box: 0, due: dayKey(0) }, ...cs]);
    setQ(''); setA('');
  };
  const gen = async () => {
    if (!topic.trim() || busy) return;
    if (!apiKey) return onOpenSettings();
    setBusy(true); setErr('');
    try {
      const t = await askAI(apiKey, [{ role: 'user', text: `Topic: ${topic.trim()}` }], 'Create 8 high-quality flashcards that build deep understanding of the topic. Reply with ONLY a JSON array like [{"q":"question","a":"short answer"}]. No markdown.');
      const arr = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
      setCards((cs) => [...arr.filter((x) => x.q && x.a).map((x) => ({ id: uid(), q: String(x.q), a: String(x.a), box: 0, due: dayKey(0) })), ...cs]);
      setTopic('');
    } catch (e) { setErr('Could not make cards. Try a narrower topic.'); }
    setBusy(false);
  };
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Micro-learning</Text>
      <Text style={[s.muted, { marginBottom: 14 }]}>Due cards pop up as a 3-second quiz when you open the app and after you finish a task, habit or focus session. Cards you know return less often.</Text>
      <Pressable disabled={!due} onPress={onReview} style={[s.planBtn, { marginTop: 0, marginBottom: 14 }, !due && { opacity: 0.4 }]}>
        <Text style={s.planText}>{due ? `Review ${due} due card${due > 1 ? 's' : ''}` : 'Nothing due. Nice.'}</Text>
      </Pressable>
      <Text style={s.fieldLabel}>Add a card</Text>
      <TextInput style={[s.addInput, { marginBottom: 8 }]} value={q} onChangeText={setQ} placeholder="Question or concept" placeholderTextColor={C.muted} keyboardAppearance="dark" />
      <AddRowInline value={a} onChange={setA} onAdd={add} placeholder="Answer" />
      <Text style={[s.fieldLabel, { marginTop: 8 }]}>Generate with AI</Text>
      <AddRowInline value={topic} onChange={setTopic} onAdd={gen} placeholder="Topic (e.g. Python decorators)" label={busy ? '…' : 'Create'} disabled={!online || busy} />
      {!!err && <Text style={[s.muted, { color: '#F87171' }]}>{err}</Text>}
      <Text style={s.section}>Deck ({cards.length})</Text>
      {cards.length === 0 && <Text style={s.empty}>No cards yet. Add one or generate a set.</Text>}
      {cards.slice(0, 40).map((c) => (
        <View key={c.id} style={s.item}>
          <Text style={s.itemText}>{c.q}</Text>
          <Text style={s.muted}>Lv {c.box + 1}</Text>
          <Pressable onPress={() => setCards((cs) => cs.filter((x) => x.id !== c.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} style={{ marginLeft: 12 }} /></Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
function AddRowInline({ value, onChange, onAdd, placeholder, label = 'Add', disabled }) {
  return (
    <View style={s.addRow}>
      <TextInput style={s.addInput} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.muted} onSubmitEditing={onAdd} keyboardAppearance="dark" />
      <Pressable disabled={disabled} onPress={onAdd} style={[s.addBtn, (disabled || !value.trim()) && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>{label}</Text></Pressable>
    </View>
  );
}

/* ---------- Brain dump (offline parser) ---------- */
function Dump({ meta, onDump }) {
  const [text, setText] = useState(''), [res, setRes] = useState(null);
  const go = () => { if (!text.trim()) return; const r = parseDump(text); onDump(r); setRes(r); setText(''); };
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Brain dump</Text>
      <Text style={[s.muted, { marginBottom: 14 }]}>Write anything, messy is fine. It works offline and instantly. Actions go to Today, insights become mental models, the rest is archived.</Text>
      <TextInput style={[s.addInput, { minHeight: 170, textAlignVertical: 'top' }]} value={text} onChangeText={setText} multiline
        placeholder="Everything on your mind…" placeholderTextColor={C.muted} keyboardAppearance="dark" />
      <Pressable onPress={go} style={[s.wide, { backgroundColor: text.trim() ? C.accent : C.disabled, marginTop: 10, maxWidth: '100%' }]}><Text style={s.addBtnText}>Sort it</Text></Pressable>
      {res && <Text style={[s.empty, { color: C.online }]}>+{res.actions.length} actions in Today · {res.models.length} models · {res.archive.length} archived</Text>}
      <Text style={s.section}>Mental models</Text>
      {meta.models.length === 0 && <Text style={s.empty}>Insights and rules you write will collect here.</Text>}
      {meta.models.slice(0, 15).map((m, i) => <View key={i} style={s.item}><Icon n="bulb-outline" size={18} color="#FBBF24" style={{ marginRight: 10 }} /><Text style={s.itemText}>{m}</Text></View>)}
      <Text style={s.section}>Archive</Text>
      {meta.archive.slice(0, 10).map((m, i) => <Text key={i} style={[s.muted, { marginBottom: 6 }]}>• {m}</Text>)}
    </ScrollView>
  );
}

/* ---------- Analytics & brain metrics ---------- */
const sum = (a) => a.reduce((x, y) => x + y, 0);
const clamp = (v) => Math.max(0, Math.min(1, v));
const lastDays = (n) => Array.from({ length: n }, (_, i) => dayKey(-i));
const longest = (log) => {
  let best = 0, run = 0, prev = null;
  [...log].sort().forEach((d) => {
    const t = new Date(d + 'T12:00:00').getTime();
    run = prev !== null && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1;
    best = Math.max(best, run); prev = t;
  });
  return best;
};

function Tile({ label, value, sub, color }) {
  return (
    <View style={s.tile}>
      <Text style={s.muted}>{label}</Text>
      <Text style={[s.tileVal, color && { color }]}>{value}</Text>
      {!!sub && <Text style={[s.muted, { fontSize: 12 }]}>{sub}</Text>}
    </View>
  );
}

function ReactionTest({ rt, onSave }) {
  const [st, setSt] = useState('idle'), [last, setLast] = useState('');
  const t0 = useRef(0), to = useRef(null);
  useEffect(() => () => clearTimeout(to.current), []);
  const press = () => {
    if (st === 'idle') { setSt('wait'); setLast(''); to.current = setTimeout(() => { t0.current = Date.now(); setSt('go'); }, 1500 + Math.random() * 2500); }
    else if (st === 'wait') { clearTimeout(to.current); setSt('idle'); setLast('Too early'); }
    else { const ms = Date.now() - t0.current; setSt('idle'); setLast(`${ms} ms`); onSave(ms); }
  };
  return (
    <View style={s.card}>
      <View style={s.btnRow}><Icon n="flash-outline" size={18} /><Text style={[s.habitTitle, { flex: 0, marginLeft: 8 }]}>Reaction time</Text></View>
      <Pressable onPress={press} style={[s.testBox, { backgroundColor: st === 'go' ? '#16A34A' : st === 'wait' ? '#B91C1C' : C.raised }]}>
        <Text style={s.testText}>{st === 'idle' ? (last ? `${last} · tap to retry` : 'Tap to start') : st === 'wait' ? 'Wait for green…' : 'TAP NOW'}</Text>
      </Pressable>
      <Text style={[s.muted, { marginTop: 8 }]}>Recent: {rt.slice(-5).join(', ') || 'no attempts yet'}{rt.length ? ' ms' : ''}</Text>
    </View>
  );
}

function SpanTest({ best, onResult }) {
  const [n, setN] = useState(Math.max(3, best || 3)), [seq, setSeq] = useState(''), [phase, setPhase] = useState('idle');
  const [ans, setAns] = useState(''), [msg, setMsg] = useState('');
  const to = useRef(null);
  useEffect(() => () => clearTimeout(to.current), []);
  const start = () => {
    setSeq(Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')); setAns(''); setMsg(''); setPhase('show');
    to.current = setTimeout(() => setPhase('input'), 900 + n * 600);
  };
  const check = () => {
    if (ans.trim() === seq) { onResult(n); setMsg(`Correct. Next round: ${n + 1} digits.`); setN(n + 1); }
    else { setMsg(`Missed. It was ${seq}.`); setN(Math.max(3, n - 1)); }
    setPhase('idle');
  };
  return (
    <View style={s.card}>
      <View style={s.btnRow}><Icon n="bulb-outline" size={18} /><Text style={[s.habitTitle, { flex: 0, marginLeft: 8 }]}>Working memory · best span {best || 0}</Text></View>
      {phase === 'show' && <Text style={s.digits}>{seq}</Text>}
      {phase === 'input' && (
        <View style={s.addRow}>
          <TextInput style={s.addInput} value={ans} onChangeText={setAns} keyboardType="number-pad" autoFocus placeholder="Type the digits" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={check} />
          <Pressable onPress={check} style={s.addBtn}><Text style={s.addBtnText}>Check</Text></Pressable>
        </View>
      )}
      {phase === 'idle' && (
        <Pressable onPress={start} style={[s.wide, { backgroundColor: C.accent, marginTop: 12 }]}><Text style={s.addBtnText}>Start {n}-digit round</Text></Pressable>
      )}
      {!!msg && <Text style={[s.muted, { marginTop: 8 }]}>{msg}</Text>}
    </View>
  );
}

function Stats({ tasks, habits, activity, cards, meta, setMeta, online, onOpen, onAnalyze }) {
  const today = dayKey(0);
  const m = useMemo(() => {
    const d7 = lastDays(7), d14 = lastDays(14), fd = meta.focusDays || {}, sl = meta.sleep || {};
    const f7 = sum(d7.map((d) => fd[d] || 0)), fPrev = sum(d14.slice(7).map((d) => fd[d] || 0));
    const rate = (n) => (habits.length ? Math.round((100 * sum(lastDays(n).map((d) => habits.filter((h) => h.log.includes(d)).length))) / (n * habits.length)) : 0);
    const keys = Object.keys(sl), avgSleep = keys.length ? sum(keys.map((k) => sl[k])) / keys.length : 0;
    const avgAct = (ks) => (ks.length ? sum(ks.map((k) => activity[k] || 0)) / ks.length : 0);
    const hi = keys.filter((k) => sl[k] >= 7), lo = keys.filter((k) => sl[k] < 7);
    const eff = CATS.map((c) => ({ c, v: tasks.filter((t) => t.cat === c.id && t.done).length + sum(habits.filter((h) => h.cat === c.id).map((h) => h.log.filter((d) => d14.includes(d)).length)) }));
    const tot = sum(eff.map((e) => e.v)), k = CATS.length;
    const balance = tot ? Math.round(100 * (1 - sum(eff.map((e) => Math.abs(e.v / tot - 1 / k))) / (2 * (1 - 1 / k)))) : 0;
    const weakest = tot ? eff.slice().sort((a, b) => a.v - b.v)[0].c : null;
    const vel = velocity(habits), mood = (meta.mood || {})[today];
    const readiness = Math.round(100 * (0.4 * clamp((sleepNow(meta) ?? 6) / (meta.sleepTarget || 8)) + 0.3 * (vel / 100) + 0.3 * (mood ? (mood.e - 1) / 4 : 0.6)));
    const rt = meta.rt || [], rtAvg = rt.length ? Math.round(sum(rt.slice(-5)) / Math.min(5, rt.length)) : null;
    const rv = meta.reviews || { ok: 0, n: 0 }, ret = rv.n ? Math.round((100 * rv.ok) / rv.n) : null;
    const parts = [readiness, rtAvg ? 100 * clamp((500 - rtAvg) / 300) : null, meta.span ? 100 * clamp(meta.span / 9) : null, ret].filter((x) => x !== null);
    return {
      f7, fPrev, h7: rate(7), h30: rate(30), avgSleep, eff, tot, balance, weakest, vel, readiness, rtAvg, ret,
      cpi: Math.round(sum(parts) / parts.length),
      edge: hi.length && lo.length ? avgAct(hi) - avgAct(lo) : null,
      ic: meta.urges + meta.slips ? Math.round((100 * meta.urges) / (meta.urges + meta.slips)) : null,
      mastered: cards.filter((c) => c.box >= 4).length,
      best: Math.max(0, ...habits.map((h) => longest(h.log))),
      planRate: (() => { const ps = lastDays(7).map((d) => (meta.plans || {})[d]).filter(Boolean), pb = sum(ps.map((p) => p.blocks.length)); return pb ? Math.round((100 * sum(ps.map((p) => p.blocks.filter((b) => b.done).length))) / pb) : null; })(),
      debt: sleepInfo(meta).debt,
      waterDays: lastDays(7).filter((d) => ((meta.water || {})[d] || 0) >= (meta.waterGoal || 8)).length,
    };
  }, [tasks, habits, activity, cards, meta]);

  const mood = (meta.mood || {})[today] || { m: 3, e: 3 };
  const setMood = (key, v) => setMeta((mt) => ({ ...mt, mood: { ...mt.mood, [today]: { m: 3, e: 3, ...(mt.mood || {})[today], [key]: v } } }));
  const hrs = meta.hours || {}, mx = Math.max(1, ...Object.values(hrs));
  const delta = m.fPrev ? Math.round(((m.f7 - m.fPrev) / m.fPrev) * 100) : null;
  const summary = `Give me a performance review from my analytics. Cognitive index ${m.cpi}, readiness ${m.readiness}, focus last 7 days ${m.f7} min (previous week ${m.fPrev}), habit rate 7d ${m.h7}% and 30d ${m.h30}%, pillar balance ${m.balance}/100${m.weakest ? ` (weakest: ${m.weakest.name})` : ''}, recall retention ${m.ret ?? 'n/a'}%, impulse control ${m.ic ?? 'n/a'}%, average sleep ${m.avgSleep.toFixed(1)}h, sleep debt ${m.debt.toFixed(1)}h, plan follow-through ${m.planRate ?? 'n/a'}%, reaction ${m.rtAvg ?? 'n/a'} ms, memory span ${meta.span || 'n/a'}. Name my 3 biggest bottlenecks and give one concrete experiment for each this week.`;

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Brain metrics</Text>
      <View style={[s.card, { marginTop: 12 }]}>
        <Text style={s.muted}>Cognitive Performance Index</Text>
        <Text style={s.velocity}>{m.cpi}</Text>
        <Text style={s.muted}>Blends readiness, reaction speed, memory span and recall. These are self-tracked indicators, not clinical measures. Take the tests below to sharpen it.</Text>
      </View>

      <View style={s.card}>
        <Text style={s.habitTitle}>Daily check-in</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
          <Text style={[s.muted, { width: 70 }]}>Mood</Text>
          {[1, 2, 3, 4, 5].map((e, i) => (
            <Pressable key={e} onPress={() => setMood('m', i + 1)} style={[s.mini, mood.m === i + 1 && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{e}</Text></Pressable>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <Text style={[s.muted, { width: 70 }]}>Energy</Text>
          {[1, 2, 3, 4, 5].map((v) => (
            <Pressable key={v} onPress={() => setMood('e', v)} style={[s.mini, mood.e === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{v}</Text></Pressable>
          ))}
        </View>
        <View style={[s.bars, { height: 60 }]}>
          {[6, 5, 4, 3, 2, 1, 0].map((i) => {
            const e = ((meta.mood || {})[dayKey(-i)] || {}).e || 0;
            return <View key={i} style={s.barCol}><View style={[s.bar, { height: 4 + e * 10, backgroundColor: e ? '#C084FC' : '#2A2A2E' }]} /></View>;
          })}
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>Energy, last 7 days</Text>
      </View>

      <View style={s.tiles}>
        <Tile label="Readiness today" value={m.readiness} sub="sleep + momentum + energy" color={m.readiness >= 70 ? C.online : m.readiness >= 45 ? '#FBBF24' : '#F87171'} />
        <Tile label="Focus, 7 days" value={`${m.f7}m`} sub={delta === null ? 'no prior week yet' : `${delta >= 0 ? '+' : ''}${delta}% vs last week`} />
        <Tile label="Deep work goal" value={`${Math.min(100, Math.round((m.f7 / 600) * 100))}%`} sub={`${(m.f7 / 60).toFixed(1)} of 10 h this week`} />
        <Tile label="Habits, 7 days" value={`${m.h7}%`} sub="completion rate" />
        <Tile label="Habits, 30 days" value={`${m.h30}%`} sub="completion rate" />
        <Tile label="Longest streak" value={`${m.best}d`} sub="any habit" />
        <Tile label="Recall retention" value={m.ret === null ? '–' : `${m.ret}%`} sub={`${m.mastered} cards mastered`} />
        <Tile label="Impulse control" value={m.ic === null ? '–' : `${m.ic}%`} sub={`${meta.urges} resisted, ${meta.slips} slips`} />
        <Tile label="Average sleep" value={m.avgSleep ? `${m.avgSleep.toFixed(1)}h` : '–'} sub="logged nights" />
        <Tile label="Sleep debt" value={`${m.debt.toFixed(1)}h`} sub="last 7 nights" color={m.debt > 5 ? '#F87171' : m.debt > 2 ? '#FBBF24' : C.online} />
        <Tile label="Plan done" value={m.planRate === null ? '\u2013' : `${m.planRate}%`} sub="plan blocks, 7 days" />
        <Tile label="Water goal" value={`${m.waterDays}/7`} sub="days hit" />
        <Tile label="Reaction (last 5)" value={m.rtAvg ? `${m.rtAvg}ms` : '–'} sub="lower is faster" />
        <Tile label="Memory span" value={meta.span || '–'} sub="digits" />
        <Tile label="Pillar balance" value={m.balance} sub={m.weakest ? `weakest: ${m.weakest.name}` : 'no data yet'} />
      </View>

      <View style={s.card}>
        <Pressable onPress={() => onOpen('sleep')} style={s.between}><Text style={s.habitTitle}>Sleep and performance</Text><View style={s.btnRow}><Text style={s.muted}>Sleep tracker</Text><Icon n="chevron-forward" size={16} color={C.muted} /></View></Pressable>
        <Text style={[s.muted, { marginTop: 6 }]}>
          {m.edge === null ? 'Log sleep on days you sleep under and over 7 hours (Sleep tracker) to see how sleep changes your output.'
            : `On nights with 7+ hours you complete ${m.edge >= 0 ? m.edge.toFixed(1) : Math.abs(m.edge).toFixed(1)} ${m.edge >= 0 ? 'more' : 'fewer'} wins per day than on shorter nights.`}
        </Text>
      </View>

      <View style={s.card}>
        <Text style={s.habitTitle}>Effort by pillar (14 days)</Text>
        {m.eff.map(({ c, v }) => (
          <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <View style={{ width: 30 }}><Icon n={c.icon} size={18} color={c.color} /></View>
            <View style={[s.track, { flex: 1, marginVertical: 0 }]}><View style={[s.fill, { width: `${m.tot ? (v / m.tot) * 100 : 0}%`, backgroundColor: c.color }]} /></View>
            <Text style={[s.muted, { width: 30, textAlign: 'right' }]}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={s.card}>
        <Text style={s.habitTitle}>Peak-hour map</Text>
        <View style={s.bars}>
          {Array.from({ length: 19 }, (_, i) => i + 5).map((h) => (
            <View key={h} style={s.barCol}>
              <View style={[s.bar, { width: 8, height: 4 + ((hrs[h] || 0) / mx) * 60, backgroundColor: hrs[h] ? C.accent : '#2A2A2E' }]} />
              <Text style={s.barLbl}>{h % 3 === 0 ? h : ''}</Text>
            </View>
          ))}
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>Hours of the day you finish focus sessions</Text>
      </View>

      <ReactionTest rt={meta.rt || []} onSave={(ms) => setMeta((mt) => ({ ...mt, rt: [...(mt.rt || []), ms].slice(-20) }))} />
      <SpanTest best={meta.span} onResult={(n) => setMeta((mt) => ({ ...mt, span: Math.max(mt.span || 0, n) }))} />

      <Pressable disabled={!online} onPress={() => onAnalyze(summary)} style={[s.wide, { backgroundColor: C.accent, opacity: online ? 1 : 0.4, maxWidth: '100%' }]}>
        <View style={s.btnRow}><Icon n="sparkles-outline" size={18} color={C.onAccent} /><Text style={[s.addBtnText, { marginLeft: 8 }]}>{online ? 'AI performance review of my stats' : 'AI review needs a connection'}</Text></View>
      </Pressable>
    </ScrollView>
  );
}

/* ---------- Focus ---------- */
function Focus({ onDone, suggest, log }) {
  const [mins, setMins] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [brk, setBrk] = useState(false);
  const [intent, setIntent] = useState('');
  const [msg, setMsg] = useState('');
  const endRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((endRef.current - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (running && left <= 0) {
      setRunning(false);
      try { Vibration.vibrate([0, 400, 200, 400]); } catch (e) {}
      if (brk) { setBrk(false); setLeft(mins * 60); setMsg('Break over. Ready for the next round?'); }
      else { onDone(mins, intent.trim()); setLeft(mins * 60); setMsg(`Session complete. +15 XP for ${mins} focused minutes.`); }
    }
  }, [left, running]);
  const pick = (m) => { if (!running) { const v = Math.max(5, Math.min(180, m)); setMins(v); setLeft(v * 60); setBrk(false); setMsg(''); } };
  const toggle = () => {
    if (!running) { endRef.current = Date.now() + left * 1000; setMsg(''); }
    setRunning(!running);
  };
  const startBreak = () => { setBrk(true); setLeft(300); endRef.current = Date.now() + 300000; setMsg(''); setRunning(true); };
  const reset = () => { setRunning(false); setBrk(false); setLeft(mins * 60); };
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Deep focus</Text>
      <Text style={[s.muted, { marginBottom: 16 }]}>Genius-level work needs uninterrupted attention. One task, phone away, nothing else open.</Text>
      <View style={s.chipRow}>
        {[15, 25, 45, 90].map((m) => (
          <Pressable key={m} onPress={() => pick(m)} style={[s.chip, mins === m && !brk && { borderColor: C.accent, backgroundColor: C.raised }]}>
            <Text style={s.chipText}>{m} min</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => pick(mins - 5)} style={s.chip}><Text style={s.chipText}>{'\u2212'}5</Text></Pressable>
        <Pressable onPress={() => pick(mins + 5)} style={s.chip}><Text style={s.chipText}>+5</Text></Pressable>
      </View>
      <TextInput style={[s.addInput, { marginTop: 4 }]} value={intent} onChangeText={setIntent} editable={!running} placeholder="What will you work on? (optional)" placeholderTextColor={C.muted} keyboardAppearance="dark" />
      {!!suggest && !intent && !running && (
        <Pressable onPress={() => setIntent(suggest)} style={[s.chip, { alignSelf: 'flex-start', marginTop: 8 }]}><Text style={[s.chipText, { fontSize: 13 }]}>Use plan: {suggest}</Text></Pressable>
      )}
      <Text style={[s.muted, { textAlign: 'center', marginTop: 20 }]}>{brk ? 'Break' : 'Focus'}</Text>
      <Text style={[s.timer, { marginTop: 4 }]}>{pad(Math.floor(left / 60))}:{pad(left % 60)}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <Pressable onPress={toggle} style={[s.addBtn, { paddingVertical: 14, paddingHorizontal: 32, marginLeft: 0 }]}>
          <Text style={s.addBtnText}>{running ? 'Pause' : brk ? 'Resume break' : 'Start focus'}</Text>
        </Pressable>
        <Pressable onPress={reset} style={[s.ghost, { marginLeft: 10, justifyContent: 'center' }]}>
          <Text style={s.ghostText}>Reset</Text>
        </Pressable>
      </View>
      {!!msg && <Text style={[s.empty, { color: C.online }]}>{msg}</Text>}
      {!running && !brk && msg.startsWith('Session complete') && (
        <Pressable onPress={startBreak} style={[s.planBtn, { alignSelf: 'center', paddingHorizontal: 24 }]}><Text style={s.planText}>Take a 5-minute break</Text></Pressable>
      )}
      <View style={[s.card, { marginTop: 24 }]}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Today's sessions</Text>
        {log.length === 0 && <Text style={[s.muted, { marginTop: 8 }]}>No sessions yet today.</Text>}
        {log.map((e, i) => (
          <View key={i} style={[s.between, { marginTop: 8 }]}>
            <Text style={[s.muted, { flex: 1 }]} numberOfLines={1}>{timeOf(e.ts)} · {e.intent || 'Deep work'}</Text>
            <Text style={s.muted}>{e.mins} min</Text>
          </View>
        ))}
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Deep work rules</Text>
        <Text style={[s.muted, { marginTop: 8 }]}>1. Write the single outcome you want before you start.{'\n'}2. Phone in another room, notifications off.{'\n'}3. When distracted, note it on paper and return.{'\n'}4. After the session, rest 5 minutes away from screens.</Text>
      </View>
    </ScrollView>
  );
}

/* ---------- Me (permanent profile + memory) ---------- */
const FIELDS = [
  ['name', 'Name', 'What should your coach call you?', false],
  ['situation', 'My situation', 'Age, school or work, schedule, constraints, resources…', true],
  ['goals', 'My goals', 'Where do you want to be in 1 year? In 5 years?', true],
  ['weaknesses', 'My weaknesses', 'Habits, fears and patterns that hold you back…', true],
  ['strengths', 'My strengths', 'What you are already good at…', true],
  ['routine', 'My routine and values', 'Wake and sleep times, commitments, what matters most…', true],
];
function Me({ profile, setProfile, memory, setMemory }) {
  const [draft, setDraft] = useState(profile);
  const ref = useRef(draft);
  ref.current = draft;
  useEffect(() => { const t = setTimeout(() => setProfile(draft), 500); return () => clearTimeout(t); }, [draft]);
  useEffect(() => () => setProfile(ref.current), []);
  const filled = FIELDS.filter(([k]) => (draft[k] || '').trim()).length;
  return (
    <ScrollView contentContainerStyle={[s.page, { paddingBottom: 260 }]} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>Your standing</Text>
      <Text style={[s.muted, { marginBottom: 6 }]}>Your coach permanently remembers everything here and uses it in every answer. The more honest you are, the sharper the advice.</Text>
      <Text style={[s.rank, { marginBottom: 14 }]}>Profile {filled}/{FIELDS.length} complete</Text>
      {FIELDS.map(([k, label, ph, multi]) => (
        <View key={k} style={{ marginBottom: 14 }}>
          <Text style={s.fieldLabel}>{label}</Text>
          <TextInput style={[s.addInput, multi && { minHeight: 84, textAlignVertical: 'top' }]} value={draft[k] || ''}
            onChangeText={(v) => setDraft((p) => ({ ...p, [k]: v }))} placeholder={ph} placeholderTextColor={C.muted}
            multiline={multi} keyboardAppearance="dark" />
        </View>
      ))}
      <Text style={s.section}>Coach memory</Text>
      <Text style={[s.muted, { marginBottom: 10 }]}>Facts your coach has learned about you in chat appear here. You can add or remove any.</Text>
      <AddRow placeholder="Add a fact (e.g. I have exams in May)" onAdd={(t) => setMemory((m) => [...new Set([...m, t])].slice(-40))} />
      {memory.length === 0 && <Text style={s.empty}>No memories yet. Chat with your coach and it will start learning.</Text>}
      {memory.map((f) => (
        <View key={f} style={s.item}>
          <Icon n="bookmark-outline" size={18} color={C.muted} style={{ marginRight: 10 }} /><Text style={s.itemText}>{f}</Text>
          <Pressable onPress={() => setMemory((m) => m.filter((x) => x !== f))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/* ---------- Coach ---------- */
const Bubble = React.memo(({ item, isLast, acts }) => {
  const u = item.role === 'user';
  const items = !u && !item.error ? listItems(item.text) : [];
  const ap = item.applied;
  return (
    <View style={[s.row, { justifyContent: u ? 'flex-end' : 'flex-start' }]}>
      <View style={{ maxWidth: '84%' }}>
        <Pressable onLongPress={() => acts.del(item.id)} delayLongPress={450} style={[s.bubble, u ? s.bubbleU : s.bubbleA, item.error && { borderColor: C.offline }, { maxWidth: '100%' }]}>
          <Text style={[s.bubbleText, item.error && { color: '#F87171' }]}>{item.text}</Text>
        </Pressable>
        {!!item.ts && <Text style={[s.barLbl, { marginTop: 3, textAlign: u ? 'right' : 'left' }]}>{timeOf(item.ts)}</Text>}
        {!!ap && (ap.undone ? <Text style={[s.muted, { marginTop: 6, fontSize: 12 }]}>Plan undone.</Text> : (
          <View style={s.applied}>
            <View style={s.btnRow}><Icon n="checkmark-circle" size={16} color={C.online} /><Text style={[s.muted, { marginLeft: 6, color: C.online }]}>Applied to your app</Text></View>
            {ap.lines.map((l, i) => <Text key={i} style={[s.muted, { marginTop: 3 }]}>• {l}</Text>)}
            <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 8 }]}>
              <Pressable onPress={acts.today} style={s.logBtn}><Text style={s.logText}>Open Today</Text></Pressable>
              <Pressable onPress={() => acts.undoPlan(item)} style={[s.logBtn, { marginLeft: 8 }]}><Text style={s.logText}>Undo</Text></Pressable>
            </View>
          </View>
        ))}
        {!u && (items.length >= 2 || item.error || isLast) && (
          <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 6, flexWrap: 'wrap' }]}>
            {items.length >= 2 && (
              <Pressable disabled={!!item.added} onPress={() => acts.addTasks(item.id, items)} style={[s.logBtn, { marginRight: 8, marginBottom: 4 }, item.added && { opacity: 0.5 }]}>
                <Text style={s.logText}>{item.added ? 'Added to tasks' : `+ Add ${items.length} to tasks`}</Text>
              </Pressable>
            )}
            {(item.error || isLast) && (
              <Pressable onPress={acts.regen} style={[s.logBtn, { marginBottom: 4 }]}>
                <View style={s.btnRow}><Icon n="refresh" size={13} /><Text style={[s.logText, { marginLeft: 5 }]}>{item.error ? 'Retry' : 'Regenerate'}</Text></View>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </View>
  );
});

function Coach({ online, hasKey, messages, thinking, mode, setMode, onSend, onOpenSettings, onClear, acts }) {
  const [input, setInput] = useState('');
  const listRef = useRef(null);
  const canSend = online && !thinking && input.trim().length > 0;
  const go = (t) => { onSend(t); setInput(''); };
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  return (
    <View style={{ flex: 1 }}>
      <View style={s.coachModes}>
        <CatChips value={mode} onChange={setMode} withAll />
        {messages.length > 0 && (
          <View style={[s.between, { marginBottom: 4 }]}>
            <Text style={s.muted}>{messages.length} message{messages.length > 1 ? 's' : ''} · long-press one to delete it</Text>
            <Pressable onPress={onClear} hitSlop={8} style={s.btnRow}><Icon n="trash-outline" size={16} color="#F87171" /><Text style={[s.muted, { color: '#F87171', marginLeft: 5 }]}>Clear chat</Text></Pressable>
          </View>
        )}
      </View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => <Bubble item={item} isLast={item.id === lastId && item.role !== 'user'} acts={acts} />}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        ListEmptyComponent={
          <View style={s.hero}>
            <Text style={s.heroTitle}>Become better, every day.</Text>
            <Text style={s.heroSub}>Your coach knows your tasks, habits, sleep and goals. Ask it to plan your day and the plan is applied across the app.</Text>
            {!hasKey && (
              <Pressable onPress={onOpenSettings} style={s.keyCta}><Text style={s.keyCtaText}>Add your free OpenRouter key to start</Text></Pressable>
            )}
            {PROMPTS[mode].map((p) => (
              <Pressable key={p} disabled={!online} onPress={() => go(p)} style={[s.suggest, !online && { opacity: 0.4 }]}>
                <Text style={s.chipText}>{p}</Text>
              </Pressable>
            ))}
          </View>
        }
        ListFooterComponent={thinking ? (
          <View style={s.row}><View style={[s.bubble, s.bubbleA]}><Text style={[s.bubbleText, { color: C.muted }]}>Thinking…</Text></View></View>
        ) : null}
      />
      <View style={s.inputWrap}>
        <View style={[s.inputBar, !online && { borderColor: '#2A1212', backgroundColor: '#080808' }]}>
          <TextInput
            style={s.input} value={input} onChangeText={setInput} editable={online} multiline blurOnSubmit={false}
            placeholder={online ? 'Ask your coach' : 'Connection lost. Chat disabled.'}
            placeholderTextColor={online ? C.muted : C.offline}
            returnKeyType="send" onSubmitEditing={() => go(input)} keyboardAppearance="dark" selectionColor={C.accent}
          />
          <Pressable onPress={() => go(input)} disabled={!canSend} accessibilityLabel="Send message"
            style={[s.send, { backgroundColor: canSend ? C.accent : C.disabled }]}>
            <Icon n="arrow-up" size={20} color={canSend ? C.onAccent : '#6B6B73'} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Opt({ label, value, opts, onPick, show }) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={s.chipRow}>
        {opts.map((o) => (
          <Pressable key={o} onPress={() => onPick(o)} style={[s.chip, { paddingVertical: 6 }, value === o && { borderColor: C.accent, backgroundColor: C.raised }]}>
            <Text style={s.chipText}>{show ? show(o) : o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function SettingsModal({ visible, apiKey, meta, setMeta, onSave, onClear, onExport, onImport, onClose }) {
  const [draft, setDraft] = useState(apiKey);
  const [err, setErr] = useState('');
  const [restore, setRestore] = useState(false), [paste, setPaste] = useState(''), [rmsg, setRmsg] = useState('');
  useEffect(() => { setDraft(apiKey); setErr(''); setRestore(false); setPaste(''); setRmsg(''); }, [apiKey, visible]);
  const doRestore = () => {
    try { onImport(paste); setPaste(''); setRestore(false); setRmsg('Backup restored.'); } catch (e) { setRmsg(e.message || 'Could not restore that backup.'); }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.modal, { maxHeight: '90%' }]}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.h1}>Settings</Text>
            <Text style={[s.muted, { marginTop: 16, marginBottom: 8 }]}>OpenRouter API key</Text>
            <TextInput style={s.keyInput} value={draft} onChangeText={setDraft} placeholder="Paste key (starts with sk-or-)"
              placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry keyboardAppearance="dark" />
            <Text style={[s.muted, { marginTop: 12, fontSize: 13 }]}>
              Stored only on this device. Get a free key at openrouter.ai/keys. Free models are run by third-party providers that may log or train on prompts, so keep sensitive details out of chats.
            </Text>
            {!!err && <Text style={[s.muted, { color: '#F87171', marginTop: 8 }]}>{err}</Text>}

            <Opt label="Sleep target (hours)" value={meta.sleepTarget || 8} opts={[6, 7, 8, 9, 10]} onPick={(v) => setMeta((m) => ({ ...m, sleepTarget: v }))} />
            <Opt label="Daily water goal (glasses)" value={meta.waterGoal || 8} opts={[6, 8, 10, 12]} onPick={(v) => setMeta((m) => ({ ...m, waterGoal: v }))} />
            <Opt label="Keep chat history" value={meta.chatKeep || 60} opts={[20, 40, 60, 100, 200]} show={(v) => `Last ${v}`} onPick={(v) => setMeta((m) => ({ ...m, chatKeep: v }))} />
            <Text style={[s.muted, { fontSize: 12, marginTop: 6 }]}>Older messages are trimmed automatically. Coach memory, plans and your data are never trimmed.</Text>

            <Text style={[s.fieldLabel, { marginTop: 18 }]}>Backup</Text>
            <View style={s.chipRow}>
              <Pressable style={s.chip} onPress={onExport}><Text style={s.chipText}>Export backup</Text></Pressable>
              <Pressable style={s.chip} onPress={() => { setRestore(!restore); setRmsg(''); }}><Text style={s.chipText}>Restore backup</Text></Pressable>
            </View>
            {restore && (
              <View>
                <TextInput style={[s.keyInput, { minHeight: 90, textAlignVertical: 'top' }]} value={paste} onChangeText={setPaste} multiline placeholder="Paste your backup text here. This replaces your current data."
                  placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardAppearance="dark" />
                <Pressable onPress={doRestore} disabled={!paste.trim()} style={[s.wide, { backgroundColor: paste.trim() ? C.accent : C.disabled, marginTop: 8 }]}><Text style={s.addBtnText}>Restore now</Text></Pressable>
              </View>
            )}
            {!!rmsg && <Text style={[s.muted, { marginTop: 6, color: rmsg.startsWith('Backup restored') ? C.online : '#F87171' }]}>{rmsg}</Text>}

            <View style={[s.between, { marginTop: 22 }]}>
              <Pressable style={s.ghost} onPress={onClear}><Text style={[s.ghostText, { color: '#F87171' }]}>Clear chat</Text></Pressable>
              <View style={{ flexDirection: 'row' }}>
                <Pressable style={s.ghost} onPress={onClose}><Text style={s.ghostText}>Close</Text></Pressable>
                <Pressable style={[s.ghost, { backgroundColor: C.accent, marginLeft: 8 }]} onPress={() => { const k = draft.trim(); if (k && !k.startsWith('sk-or-')) return setErr('That does not look like an OpenRouter key. It should start with sk-or-.'); setErr(''); onSave(k); }}>
                  <Text style={[s.ghostText, { color: C.onAccent }]}>Save key</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ---------- App ---------- */
export default function App() {
  const online = useIsOnline();
  const [tab, setTab] = useState('today');
  const [tasks, setTasks] = useState([]);
  const [habits, setHabits] = useState([]);
  const [xp, setXp] = useState(0);
  const [profile, setProfile] = useState({});
  const [memory, setMemory] = useState([]);
  const [activity, setActivity] = useState({});
  const [focusMin, setFocusMin] = useState(0);
  const [cards, setCards] = useState([]);
  const [meta, setMeta] = useState(DEFAULT_META);
  const [override, setOverride] = useState(false);
  const [shield, setShield] = useState(null);
  const [quizId, setQuizId] = useState(null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const lastQuiz = useRef(0);
  const toastId = useRef(0);
  const [messages, setMessages] = useState([]);
  const [mode, setMode] = useState('all');
  const [thinking, setThinking] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const tasksRef = useRef(tasks); tasksRef.current = tasks;
  const habitsRef = useRef(habits); habitsRef.current = habits;

  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  const pk = peakWindow(meta);
  const nd = new Date(), nowH = nd.getHours() + nd.getMinutes() / 60;
  const inPeak = nowH >= pk.start && nowH < pk.end;
  useEffect(() => { if (!inPeak) setOverride(false); }, [inPeak]);

  const showToast = (text, undo) => {
    const id = ++toastId.current;
    setToast({ id, text, undo });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 7000);
  };
  const ask = (title, body, label, yes) => setConfirm({ title, body, label, yes });

  const hydrate = (p) => {
    setTasks(p.tasks || []); setHabits(p.habits || []); setXp(p.xp || 0); setMessages(p.messages || []);
    setProfile(p.profile || {}); setMemory(p.memory || []); setActivity(p.activity || {}); setFocusMin(p.focusMin || 0);
    setCards(p.cards || []); setMeta({ ...DEFAULT_META, ...(p.meta || {}) });
  };

  useEffect(() => {
    (async () => {
      try {
        const k = await AsyncStorage.getItem(KEY_STORE);
        const d = (await AsyncStorage.getItem(DATA_STORE)) || (await AsyncStorage.getItem('grokbot:data'));
        if (k) setApiKey(k);
        if (d) hydrate(JSON.parse(d));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const keep = meta.chatKeep || 60;
    const t = setTimeout(() => AsyncStorage.setItem(DATA_STORE, JSON.stringify({ tasks, habits, xp, profile, memory, activity, focusMin, cards, meta, messages: messages.slice(-keep) })).catch(() => {}), 700);
    return () => clearTimeout(t);
  }, [tasks, habits, xp, profile, memory, activity, focusMin, cards, meta, messages, loaded]);

  // Keeps the chat from growing forever: trims the oldest messages past your chosen limit
  useEffect(() => {
    const k = meta.chatKeep || 60;
    if (messages.length > k + 10) setMessages((p) => p.slice(-k));
  }, [messages.length, meta.chatKeep]);

  // Recurring tasks come back on their own (daily, or weekly after 7 days)
  useEffect(() => {
    if (!loaded) return;
    const t = dayKey(0);
    const due = (x) => x.repeat && x.done && x.doneOn !== t && (x.repeat === 'daily' || !x.doneOn || daysBetween(x.doneOn, t) >= 7);
    setTasks((p) => (p.some(due) ? p.map((x) => (due(x) ? { ...x, done: false, doneOn: undefined } : x)) : p));
  }, [loaded, tick]);

  const bdg = useMemo(() => badgeDefs(xp, focusMin, habits, cards, meta), [xp, focusMin, habits, cards, meta]);
  useEffect(() => {
    if (!loaded) return;
    const have = meta.badges || [], fresh = bdg.filter((b) => b.ok && !have.includes(b.id));
    if (!fresh.length) return;
    setMeta((m) => ({ ...m, badges: [...(m.badges || []), ...fresh.map((b) => b.id)] }));
    showToast(fresh.length === 1 ? `Badge unlocked: ${fresh[0].name}` : `${fresh.length} badges unlocked. Open Badges on Today.`);
  }, [bdg, loaded]);

  const maybeQuiz = useCallback(() => {
    if (Date.now() - lastQuiz.current < 90000) return;
    const due = cards.find((c) => c.due <= dayKey(0));
    if (due) { lastQuiz.current = Date.now(); setQuizId(due.id); }
  }, [cards]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => st === 'active' && maybeQuiz());
    return () => sub.remove();
  }, [maybeQuiz]);
  useEffect(() => { if (loaded) maybeQuiz(); }, [loaded]);
  const rateCard = (id, good) => {
    setCards((cs) => cs.map((c) => { if (c.id !== id) return c; const box = good ? Math.min(c.box + 1, 6) : 0; return { ...c, box, due: dayKey(INTERVALS[box]) }; }));
    if (good) setXp((x) => x + 2);
    setMeta((m) => ({ ...m, reviews: { ok: m.reviews.ok + (good ? 1 : 0), n: m.reviews.n + 1 } }));
    setQuizId(null);
  };
  const shieldChoose = (asset) => {
    const kind = shield; setShield(null);
    if (kind === 'override') { if (asset) setOverride(true); return; }
    if (asset) { setMeta((m) => ({ ...m, urges: m.urges + 1 })); setXp((x) => x + 5); setTab('focus'); }
    else setMeta((m) => ({ ...m, slips: m.slips + 1 }));
  };
  const bump = (n) => setActivity((a) => ({ ...a, [dayKey(0)]: Math.max(0, (a[dayKey(0)] || 0) + n) }));
  const finishFocus = (m, intent = '') => {
    const h = new Date(Date.now() - m * 60000).getHours();
    setXp((x) => x + 15); setFocusMin((f) => f + m); bump(1);
    setMeta((mt) => ({
      ...mt,
      hours: { ...mt.hours, [h]: (mt.hours[h] || 0) + 1 },
      focusDays: { ...mt.focusDays, [dayKey(0)]: ((mt.focusDays || {})[dayKey(0)] || 0) + m },
      focusLog: [...(mt.focusLog || []), { ts: Date.now(), mins: m, intent }].slice(-80),
    }));
    setTimeout(maybeQuiz, 700);
  };
  const dump = (r) => {
    r.actions.forEach((t) => addTask(t, 'discipline'));
    setMeta((m) => ({ ...m, models: [...new Set([...r.models, ...m.models])].slice(0, 60), archive: [...r.archive, ...m.archive].slice(0, 100) }));
    bump(1);
  };

  /* Tasks and habits */
  const addTask = (title, cat, repeat) => setTasks((p) => [{ id: uid(), title, cat, done: false, ...(repeat ? { repeat } : {}) }, ...p]);
  // Keeps today's plan blocks in step with the task or habit they are linked to
  const syncBlocks = (key, id, val) => setMeta((m) => {
    const p = (m.plans || {})[dayKey(0)];
    if (!p || !p.blocks.some((b) => b[key] === id)) return m;
    return { ...m, plans: { ...m.plans, [p.date]: { ...p, blocks: p.blocks.map((b) => (b[key] === id ? { ...b, done: val } : b)) } } };
  });
  const toggleTask = (id) => {
    const t = tasksRef.current.find((x) => x.id === id);
    if (!t) return;
    const nd2 = !t.done;
    setXp((x) => Math.max(0, x + (nd2 ? 10 : -10)));
    bump(nd2 ? 1 : -1);
    if (nd2) setTimeout(maybeQuiz, 700);
    setTasks((p) => p.map((x) => (x.id === id ? { ...x, done: nd2, doneOn: nd2 ? dayKey(0) : undefined } : x)));
    syncBlocks('taskId', id, nd2);
  };
  const addHabit = (title, cat) => setHabits((p) => [...p, { id: uid(), title, cat, log: [] }]);
  const toggleHabit = (id) => {
    const h = habitsRef.current.find((x) => x.id === id), today = dayKey(0);
    if (!h) return;
    const has = h.log.includes(today);
    setXp((x) => Math.max(0, x + (has ? -5 : 5)));
    bump(has ? -1 : 1);
    if (!has) setTimeout(maybeQuiz, 700);
    setHabits((p) => p.map((x) => (x.id === id ? { ...x, log: has ? x.log.filter((d) => d !== today) : [...x.log, today] } : x)));
    syncBlocks('habitId', id, !has);
  };
  const deleteTask = (id) => {
    const i = tasks.findIndex((x) => x.id === id);
    if (i < 0) return;
    const t = tasks[i];
    setTasks((p) => p.filter((x) => x.id !== id));
    showToast(`Deleted "${t.title}"`, () => setTasks((p) => { const c = [...p]; c.splice(Math.min(i, c.length), 0, t); return c; }));
  };
  const deleteHabit = (id) => {
    const i = habits.findIndex((x) => x.id === id);
    if (i < 0) return;
    const h = habits[i];
    setHabits((p) => p.filter((x) => x.id !== id));
    showToast(`Deleted habit "${h.title}"`, () => setHabits((p) => { const c = [...p]; c.splice(Math.min(i, c.length), 0, h); return c; }));
  };
  const clearDone = () => {
    const gone = tasks.filter((t) => t.done);
    if (!gone.length) return;
    setTasks((p) => p.filter((t) => !t.done));
    showToast(`Cleared ${gone.length} completed task${gone.length > 1 ? 's' : ''}`, () => setTasks((p) => [...p, ...gone]));
  };
  const starTask = (id) => setTasks((p) => p.map((t) => (t.id === id ? { ...t, star: !t.star } : t)));
  const cycleRepeat = (id) => setTasks((p) => p.map((t) => (t.id === id ? { ...t, repeat: t.repeat === 'daily' ? 'weekly' : undefined } : t)));
  const changeWater = (d) => {
    const k = dayKey(0), cur = (meta.water || {})[k] || 0, wg = meta.waterGoal || 8, nx = Math.max(0, Math.min(30, cur + d));
    if (nx === cur) return;
    setMeta((m) => ({ ...m, water: { ...m.water, [k]: nx } }));
    if (cur < wg && nx >= wg) { setXp((x) => x + 5); bump(1); }
    if (cur >= wg && nx < wg) { setXp((x) => Math.max(0, x - 5)); bump(-1); }
  };
  const saveJournal = (text, prompt) => {
    const k = dayKey(0), first = !(meta.journal || []).some((j) => j.date === k);
    setMeta((m) => ({ ...m, journal: [{ id: uid(), date: k, ts: Date.now(), text, prompt }, ...(m.journal || [])].slice(0, 300) }));
    if (first) { setXp((x) => x + 5); bump(1); }
  };

  /* Plan blocks and plan application */
  const setBlock = (id, v) => setMeta((m) => {
    const p = (m.plans || {})[dayKey(0)];
    if (!p) return m;
    return { ...m, plans: { ...m.plans, [p.date]: { ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, done: v } : b)) } } };
  });
  const toggleBlock = (id) => {
    const p = (meta.plans || {})[dayKey(0)], b = p && p.blocks.find((x) => x.id === id);
    if (!b) return;
    const nd2 = !b.done;
    const t = b.taskId && tasksRef.current.find((x) => x.id === b.taskId);
    const h = b.habitId && habitsRef.current.find((x) => x.id === b.habitId);
    if (t) { if (t.done !== nd2) toggleTask(t.id); else setBlock(id, nd2); return; }
    if (h) { if (h.log.includes(dayKey(0)) !== nd2) toggleHabit(h.id); else setBlock(id, nd2); return; }
    setBlock(id, nd2);
    setXp((x) => Math.max(0, x + (nd2 ? 5 : -5)));
    bump(nd2 ? 1 : -1);
  };
  const applyPlan = (pl, date) => {
    const pid = uid(), hs = habitsRef.current, open = tasksRef.current.filter((t) => !t.done);
    const fresh = pl.tasks.filter((t) => !open.some((o) => sameish(o.title, t.title))).map((t) => ({ id: uid(), title: t.title, cat: t.cat, done: false, planId: pid }));
    let star = null;
    if (pl.focus) {
      const hit = [...fresh, ...open].find((t) => sameish(t.title, pl.focus));
      if (hit) star = hit.id;
      else { const f = { id: uid(), title: pl.focus, cat: guessCat(pl.focus), done: false, star: true, planId: pid }; fresh.push(f); star = f.id; }
    }
    fresh.forEach((t) => { if (t.id === star) t.star = true; });
    const pool = [...fresh, ...open];
    const blocks = pl.blocks.map((b) => {
      const t = pool.find((x) => (b.ref && sameish(x.title, b.ref)) || sameish(x.title, b.title));
      const h = !t && hs.find((x) => (b.ref && sameish(x.title, b.ref)) || sameish(x.title, b.title));
      return { id: uid(), start: b.start, end: b.end, title: b.title, cat: b.cat, done: !!(h && date === dayKey(0) && h.log.includes(dayKey(0))), ...(t ? { taskId: t.id } : h ? { habitId: h.id } : {}) };
    });
    setTasks((p) => [...fresh, ...p.map((t) => (t.id === star ? { ...t, star: true } : t))]);
    setMeta((m) => ({ ...m, plans: prunePlans({ ...(m.plans || {}), [date]: { id: pid, date, focus: pl.focus, blocks } }) }));
    const lines = [`${blocks.length} time blocks ${date === dayKey(0) ? 'on Today' : 'saved for tomorrow'}`];
    if (fresh.length) lines.push(`${fresh.length} task${fresh.length > 1 ? 's' : ''} added: ${fresh.slice(0, 3).map((t) => t.title).join(', ')}${fresh.length > 3 ? '…' : ''}`);
    const linked = blocks.filter((b) => b.taskId || b.habitId).length;
    if (linked) lines.push(`${linked} block${linked > 1 ? 's' : ''} linked to your tasks and habits`);
    if (pl.focus) lines.push(`Priority: ${pl.focus}`);
    return { date, pid, taskIds: fresh.map((t) => t.id), lines };
  };
  const undoPlan = (msg) => {
    const a = msg.applied;
    if (!a || a.undone) return;
    setMeta((mt) => { const pl = { ...(mt.plans || {}) }; if (pl[a.date] && pl[a.date].id === a.pid) delete pl[a.date]; return { ...mt, plans: pl }; });
    setTasks((p) => p.filter((t) => !(a.taskIds.includes(t.id) && !t.done)));
    setMessages((p) => p.map((x) => (x.id === msg.id ? { ...x, applied: { ...a, undone: true } } : x)));
  };
  const clearPlan = () => {
    const key = dayKey(0), prev = (meta.plans || {})[key];
    if (!prev) return;
    setMeta((m) => { const pl = { ...(m.plans || {}) }; delete pl[key]; return { ...m, plans: pl }; });
    showToast('Plan cleared', () => setMeta((m) => ({ ...m, plans: { ...(m.plans || {}), [key]: prev } })));
  };

  /* Coach */
  const coachContext = (isPlan, off) => {
    const d = new Date(), now = d.getHours() + d.getMinutes() / 60, si = sleepInfo(meta), tk = dayKey(0), pl = (meta.plans || {})[tk];
    const goals = (meta.goals || []).filter((g) => !g.done).map((g) => `- [${g.cat}] ${g.title} (${g.current}/${g.target})`).join('\n') || '(none)';
    const lines = [
      `Time now: ${fmt(now)}. Usual wake time: ${fmt(meta.wake)}. Peak focus window: ${fmt(pk.start)} to ${fmt(pk.end)}. Target bedtime: ${fmt(si.bedTonight)} (sleep target ${si.target}h).`,
      `Sleep: last night ${si.last == null ? 'not logged' : hm(si.last)}; 7-night average ${si.avg7 == null ? 'n/a' : hm(si.avg7)}; sleep debt ${si.debt.toFixed(1)}h; bedtime consistency ${si.spread == null ? 'n/a' : `+/-${si.spread} min`}.`,
      `Water today: ${(meta.water || {})[tk] || 0}/${meta.waterGoal || 8}. Energy today (1-5): ${((meta.mood || {})[tk] || {}).e ?? 'not logged'}.`,
      `Active goals:\n${goals}`,
      pl ? `Today's plan already applied in the app: ${pl.blocks.map((b) => `${fmt(b.start)} ${b.title}${b.done ? ' (done)' : ''}`).join('; ')}` : 'No plan applied for today yet.',
    ];
    if (isPlan) lines.push(planRules(off ? 'tomorrow' : 'today', dayKey(off), now, off, si.bedTonight));
    return lines.join('\n');
  };
  const run = async (history, text, opts = {}) => {
    setThinking(true);
    const isPlan = PLAN_RE.test(text), off = isPlan ? planOffset(text) : 0;
    try {
      const raw = await askAI(apiKey, history, buildSystem(mode, tasksRef.current, habitsRef.current, profile, memory, { extra: coachContext(isPlan, off) }), isPlan ? 1800 : 1200);
      const facts = [...raw.matchAll(/\[\[remember:\s*([\s\S]+?)\]\]/gi)].map((m) => m[1].trim());
      const stripped = raw.replace(/\[\[remember:[\s\S]*?\]\]/gi, '').trim() || raw;
      if (facts.length) setMemory((m) => [...new Set([...m, ...facts])].slice(-40));
      let msg = { id: uid(), role: 'ai', text: stripped.replace(PLAN_TAG, '').trim() || stripped, ts: Date.now() };
      if (isPlan) {
        const { text: shown, plan } = extractPlan(stripped);
        if (plan) {
          const r = applyPlan(plan, dayKey(off));
          msg = { ...msg, text: shown, applied: { date: r.date, pid: r.pid, taskIds: r.taskIds, lines: r.lines } };
          if (opts.stay) showToast(off ? 'Plan saved for tomorrow' : 'Plan applied to Today');
        } else {
          msg = { ...msg, text: `${shown}\n\n(I could not turn this into app changes automatically. Ask again and I will retry.)` };
          if (opts.stay) showToast('Coach replied, but the plan could not be applied. Check the Coach tab and retry.');
        }
      }
      setMessages((p) => [...p, msg]);
    } catch (e) {
      const text2 = e.message || 'Something went wrong.';
      setMessages((p) => [...p, { id: uid(), role: 'ai', text: text2, error: true, ts: Date.now() }]);
      if (opts.stay) showToast(text2);
    } finally {
      setThinking(false);
    }
  };
  const send = (raw, opts) => {
    const text = raw.trim();
    if (!online || !text || thinking) return;
    if (!apiKey) { setShowSettings(true); return; }
    const u = { id: uid(), role: 'user', text, ts: Date.now() };
    const history = [...messages.filter((m) => !m.error), u];
    setMessages((p) => [...p, u]);
    run(history, text, opts);
  };
  const regen = () => {
    if (thinking || !online) return;
    const i = messages.map((m) => m.role).lastIndexOf('user');
    if (i < 0) return;
    const base = messages.slice(0, i + 1);
    setMessages(base);
    run(base.filter((m) => !m.error), base[i].text);
  };
  const planNow = () => {
    if (thinking) return;
    const late = new Date().getHours() >= 21;
    send(`Plan my day${late ? ' tomorrow' : ' today'}. Use my open tasks, habits, goals, sleep and peak window, and time-block it. Tell me the one thing that matters most.`, { stay: true });
  };
  const deleteMsg = (id) => {
    const i = messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = messages[i];
    setMessages((p) => p.filter((x) => x.id !== id));
    showToast('Message deleted', () => setMessages((p) => { const c = [...p]; c.splice(Math.min(i, c.length), 0, m); return c; }));
  };
  const addReplyTasks = (id, items) => {
    const have = tasksRef.current.filter((t) => !t.done);
    const fresh = items.filter((x) => !have.some((t) => sameish(t.title, x))).map((x) => ({ id: uid(), title: x, cat: mode === 'all' ? guessCat(x) : mode, done: false }));
    if (fresh.length) setTasks((p) => [...fresh, ...p]);
    setMessages((p) => p.map((m) => (m.id === id ? { ...m, added: true } : m)));
    showToast(fresh.length ? `Added ${fresh.length} task${fresh.length > 1 ? 's' : ''} to Today` : 'Those are already in your tasks', fresh.length ? () => setTasks((p) => p.filter((t) => !fresh.some((f) => f.id === t.id))) : undefined);
  };
  const requestClear = () => {
    if (!messages.length) { showToast('The chat is already empty'); return; }
    ask('Clear this chat?', `This removes ${messages.length} message${messages.length > 1 ? 's' : ''}. Your coach memory, profile, tasks and plans stay. You can undo for a few seconds afterwards.`, 'Clear chat', () => {
      const prev = messages;
      setMessages([]);
      showToast('Chat cleared', () => setMessages(prev));
    });
  };

  /* Backup */
  const exportData = async () => {
    try { await Share.share({ message: JSON.stringify({ app: 'autokinetics', v: 2, exported: new Date().toISOString(), tasks, habits, xp, profile, memory, activity, focusMin, cards, meta, messages: messages.slice(-30) }) }); }
    catch (e) { showToast('Sharing is not available here.'); }
  };
  const importData = (text) => {
    let p;
    try { p = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) { throw new Error('Could not read that. Paste the full backup text.'); }
    if (!p || !Array.isArray(p.tasks) || !Array.isArray(p.habits)) throw new Error('That does not look like an AutoKinetics backup.');
    hydrate(p);
    showToast('Backup restored');
  };
  const saveKey = async (k) => {
    setApiKey(k);
    try { await AsyncStorage.setItem(KEY_STORE, k); } catch (e) {}
    setShowSettings(false);
  };

  const plan = (meta.plans || {})[dayKey(0)] || null, tomorrowPlan = (meta.plans || {})[dayKey(1)] || null;
  const score = dayScore(tasks, habits, meta, plan);
  const nudgeList = nudges({ meta, habits, cards, plan, pk, inPeak, online });
  const nextBlock = plan && plan.blocks.find((b) => !b.done && nowH < b.end);
  const focusLog = (meta.focusLog || []).filter((e) => keyOf(e.ts) === dayKey(0));
  const acts = { del: deleteMsg, addTasks: addReplyTasks, regen, undoPlan, today: () => setTab('today') };

  const SUBS = ['sleep', 'journal', 'goals', 'badges', 'review'];
  const view = meta.lock && inPeak && !override && ['habits', 'coach', 'me', 'learn'].includes(tab) ? 'gate' : tab;
  const hl = SUBS.includes(tab) ? 'today' : tab;
  const back = () => setTab('today');
  const analyze = (t) => { setMode('all'); setTab('coach'); send(t); };
  const TABS = [{ id: 'today', icon: 'checkmark-circle', label: 'Today' }, { id: 'habits', icon: 'flame', label: 'Habits' }, { id: 'focus', icon: 'timer', label: 'Focus' }, { id: 'learn', icon: 'albums', label: 'Learn' }, { id: 'dump', icon: 'create', label: 'Dump' }, { id: 'stats', icon: 'stats-chart', label: 'Stats' }, { id: 'coach', icon: 'chatbubble-ellipses', label: 'Coach' }, { id: 'me', icon: 'person', label: 'Me' }];

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
        {!online && <View style={s.offlineBanner}><Text style={s.offlineText}>Offline Mode</Text></View>}

        <View style={s.header}>
          <Logo />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {online && (
              <View style={s.badge}><View style={s.badgeDot} /><Text style={s.badgeText}>Online</Text></View>
            )}
            <Pressable onPress={() => setShowSettings(true)} style={s.gear} accessibilityLabel="Settings"><Icon n="settings-outline" size={22} color={C.muted} /></Pressable>
          </View>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          {view === 'gate' && <Gate end={fmt(pk.end)} onFocus={() => setTab('focus')} onOverride={() => setShield('override')} />}
          {view === 'learn' && <Learn cards={cards} setCards={setCards} online={online} apiKey={apiKey} onOpenSettings={() => setShowSettings(true)} onReview={() => { lastQuiz.current = 0; maybeQuiz(); }} />}
          {view === 'dump' && <Dump meta={meta} onDump={dump} />}
          {view === 'stats' && <Stats tasks={tasks} habits={habits} activity={activity} cards={cards} meta={meta} setMeta={setMeta} online={online} onOpen={setTab} onAnalyze={analyze} />}
          {view === 'today' && (
            <Today name={(profile.name || '').trim()} tasks={tasks} habits={habits} xp={xp} online={online} busy={thinking} activity={activity} focusMin={focusMin}
              meta={meta} setMeta={setMeta} pk={pk} inPeak={inPeak} plan={plan} tomorrowPlan={tomorrowPlan} score={score} nudgeList={nudgeList}
              onOpen={setTab} onUrge={() => setShield('urge')} onToggle={toggleTask} onAdd={addTask} onDelete={deleteTask} onPlan={planNow}
              onStar={starTask} onRepeat={cycleRepeat} onClearDone={clearDone} onToggleBlock={toggleBlock} onClearPlan={clearPlan} onWater={changeWater} />
          )}
          {view === 'habits' && <Habits habits={habits} onToggle={toggleHabit} onAdd={addHabit} onDelete={deleteHabit} />}
          {view === 'focus' && <Focus onDone={finishFocus} suggest={nextBlock ? nextBlock.title : ''} log={focusLog} />}
          {view === 'me' && <Me profile={profile} setProfile={setProfile} memory={memory} setMemory={setMemory} />}
          {view === 'coach' && (
            <Coach online={online} hasKey={!!apiKey} messages={messages} thinking={thinking} mode={mode} setMode={setMode}
              onSend={send} onOpenSettings={() => setShowSettings(true)} onClear={requestClear} acts={acts} />
          )}
          {view === 'sleep' && <Sleep meta={meta} setMeta={setMeta} activity={activity} onBack={back} />}
          {view === 'journal' && <Journal meta={meta} setMeta={setMeta} onSave={saveJournal} onBack={back} />}
          {view === 'goals' && <Goals meta={meta} setMeta={setMeta} onXp={(d) => setXp((x) => Math.max(0, x + d))} onBack={back} />}
          {view === 'badges' && <Badges list={bdg} onBack={back} />}
          {view === 'review' && <Review habits={habits} activity={activity} meta={meta} online={online} onBack={back} onAnalyze={analyze} />}
        </KeyboardAvoidingView>

        <View style={s.tabBar}>
          {TABS.map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={s.tab}>
              <Icon n={hl === t.id ? t.icon : `${t.icon}-outline`} size={22} color={hl === t.id ? C.text : C.muted} />
              <Text style={[s.tabLabel, hl === t.id && { color: C.text }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        <Shield visible={!!shield} context={shield === 'override' ? 'You are about to break your Peak Lock.' : 'You feel an urge to escape the hard thing.'} onChoose={shieldChoose} />
        <MicroQuiz card={cards.find((c) => c.id === quizId)} onRate={rateCard} onClose={() => setQuizId(null)} />
        <SettingsModal visible={showSettings} apiKey={apiKey} meta={meta} setMeta={setMeta} onSave={saveKey} onExport={exportData} onImport={importData}
          onClear={() => { setShowSettings(false); setTimeout(requestClear, 350); }} onClose={() => setShowSettings(false)} />
        <Confirm c={confirm} onNo={() => setConfirm(null)} />
        <Toast toast={toast} onUndo={() => { const f = toast && toast.undo; setToast(null); if (f) f(); }} onClose={() => setToast(null)} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ---------- Styles ---------- */
const MAX_W = 760;
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  offlineBanner: { backgroundColor: C.offline, paddingVertical: 8, alignItems: 'center' },
  offlineText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  brand: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  badge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(34,197,94,0.14)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  badgeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.online, marginRight: 7 },
  badgeText: { color: C.online, fontSize: 13, fontWeight: '600' },
  gear: { marginLeft: 12, width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  gearText: { color: C.muted, fontSize: 22 },

  page: { width: '100%', maxWidth: MAX_W, alignSelf: 'center', padding: 20, paddingBottom: 40 },
  h1: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  rank: { color: C.muted, fontSize: 15, fontWeight: '600' },
  section: { color: C.text, fontSize: 20, fontWeight: '700', marginTop: 24, marginBottom: 12 },
  muted: { color: C.muted, fontSize: 14, lineHeight: 20 },
  empty: { color: C.muted, fontSize: 15, textAlign: 'center', marginVertical: 24 },
  card: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 18, padding: 16, marginBottom: 12 },
  track: { height: 6, backgroundColor: '#1E1E22', borderRadius: 3, overflow: 'hidden', marginVertical: 10 },
  fill: { height: 6, borderRadius: 3 },
  pillarRow: { flexDirection: 'row', marginTop: 4 },
  pillar: { flex: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12, marginRight: 8 },
  pillarIcon: { fontSize: 22 },
  pillarText: { color: C.muted, fontSize: 13 },
  planBtn: { backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 14, marginTop: 12, alignItems: 'center' },
  planText: { color: C.text, fontSize: 15, fontWeight: '600' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8, backgroundColor: C.surface },
  chipText: { color: C.text, fontSize: 15 },
  addRow: { flexDirection: 'row', marginTop: 4, marginBottom: 12 },
  addInput: { flex: 1, color: C.text, fontSize: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  addBtn: { backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 18, justifyContent: 'center', marginLeft: 8 },
  addBtnText: { color: C.onAccent, fontWeight: '700', fontSize: 15 },

  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 14, marginBottom: 8 },
  check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  tick: { color: '#000', fontWeight: '800', fontSize: 14 },
  itemText: { flex: 1, color: C.text, fontSize: 16 },
  done: { color: C.muted, textDecorationLine: 'line-through' },
  itemIcon: { fontSize: 16, marginHorizontal: 10 },
  x: { color: C.muted, fontSize: 16 },
  habitTitle: { color: C.text, fontSize: 17, fontWeight: '600', flex: 1 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: C.disabled, marginRight: 5 },
  logBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  logText: { color: C.text, fontWeight: '600', fontSize: 14 },

  coachModes: { width: '100%', maxWidth: MAX_W, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 12 },
  list: { flexGrow: 1, width: '100%', maxWidth: MAX_W, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 8 },
  row: { width: '100%', marginVertical: 5, flexDirection: 'row' },
  bubble: { maxWidth: '84%', paddingHorizontal: 16, paddingVertical: 11, borderRadius: 20 },
  bubbleU: { backgroundColor: '#232326', borderBottomRightRadius: 6 },
  bubbleA: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderBottomLeftRadius: 6 },
  bubbleText: { color: C.text, fontSize: 16, lineHeight: 23 },
  hero: { flex: 1, justifyContent: 'center', paddingBottom: 24, alignItems: 'flex-start' },
  heroTitle: { color: C.text, fontSize: 36, fontWeight: '800', letterSpacing: -1.2, lineHeight: 40 },
  heroSub: { color: C.muted, fontSize: 16, lineHeight: 23, marginTop: 10, marginBottom: 18, maxWidth: 480 },
  keyCta: { backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 12, marginBottom: 16 },
  keyCtaText: { color: C.onAccent, fontSize: 15, fontWeight: '700' },
  suggest: { borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 11, marginBottom: 10, backgroundColor: C.surface },
  inputWrap: { width: '100%', maxWidth: MAX_W, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 26, paddingLeft: 18, paddingRight: 7, paddingVertical: 7 },
  input: { flex: 1, color: C.text, fontSize: 16, maxHeight: 120, minHeight: 36, paddingTop: Platform.OS === 'ios' ? 8 : 4, paddingBottom: Platform.OS === 'ios' ? 8 : 4, paddingRight: 8 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendIcon: { color: C.onAccent, fontSize: 20, fontWeight: '700', marginTop: -1 },

  tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabIcon: { fontSize: 22 },
  tabLabel: { color: C.muted, fontSize: 12, marginTop: 2, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modal: { width: '100%', maxWidth: 480, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 22, padding: 22 },
  keyInput: { color: C.text, fontSize: 16, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  ghost: { backgroundColor: '#17171A', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11 },
  ghostText: { color: C.text, fontSize: 15, fontWeight: '600' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 100, marginTop: 10 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: 18, borderRadius: 5, marginVertical: 3 },
  barLbl: { color: C.muted, fontSize: 11 },
  timer: { color: C.text, fontSize: 84, fontWeight: '200', textAlign: 'center', marginVertical: 28, fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginBottom: 8 },
  tile: { width: '31.8%', margin: '0.7%', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12 },
  tileVal: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.8, marginVertical: 2 },
  testBox: { height: 120, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  testText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  digits: { color: C.text, fontSize: 48, fontWeight: '700', letterSpacing: 8, textAlign: 'center', marginVertical: 24 },
  logoRow: { flexDirection: 'row', alignItems: 'center' },
  logoMark: { width: 30, height: 30, borderRadius: 9, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  bigIconWrap: { width: 68, height: 68, borderRadius: 34, backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  bigIcon: { fontSize: 48, marginBottom: 8 },
  bigQ: { color: C.text, fontSize: 24, fontWeight: '700', lineHeight: 30, marginTop: 14 },
  count: { color: C.text, fontSize: 72, fontWeight: '200', marginVertical: 14 },
  wide: { width: '100%', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  mini: { borderWidth: 1, borderColor: C.border, borderRadius: 10, width: 38, paddingVertical: 6, alignItems: 'center', marginRight: 6 },
  velocity: { color: C.text, fontSize: 46, fontWeight: '800', letterSpacing: -1.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: 7 * 22 },
  px: { width: 18, height: 18, margin: 2, borderRadius: 4 },
  fieldLabel: { color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 6 },
  stepBtn: { minWidth: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  stepVal: { color: C.text, fontSize: 18, fontWeight: '700', minWidth: 90, textAlign: 'center', fontVariant: ['tabular-nums'] },
  planRow: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 12, borderWidth: 1, borderColor: 'transparent', marginBottom: 4 },
  toolRow: { flexDirection: 'row', marginBottom: 12, marginRight: -6 },
  tool: { flex: 1, alignItems: 'center', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingVertical: 10, marginRight: 6 },
  glass: { width: 18, height: 22, margin: 3, borderRadius: 5, borderWidth: 1.5, borderColor: C.disabled },
  applied: { marginTop: 6, backgroundColor: C.surface, borderWidth: 1, borderColor: '#14532D', borderRadius: 14, padding: 12 },
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C20', borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, width: '100%', maxWidth: 520, elevation: 8 },
  toastBtn: { color: '#60A5FA', fontWeight: '700', fontSize: 14, marginLeft: 12 },
});
