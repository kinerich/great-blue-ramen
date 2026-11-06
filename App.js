import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  Share, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, Vibration, View,
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
  if (meta.peakOverride) return { start: meta.peakOverride.start, end: meta.peakOverride.end, learned: true, custom: true };
  const hrs = meta.hours || {}, total = Object.values(hrs).reduce((a, b) => a + b, 0);
  const best = Object.keys(hrs).sort((a, b) => hrs[b] - hrs[a])[0];
  const sleep = sleepNow(meta) ?? 7, short = sleep < 6;
  const learned = total >= 3 && best !== undefined;
  // Energy map taps are the second source: after about 10 taps they stand in for missing focus data
  const eb = !learned ? bestEnergy(meta.energy || []) : null;
  const start = (learned ? +best : eb ? eb.start : meta.wake + 2) + (short ? 1 : 0);
  return { start, end: start + (short ? 1.5 : 2), learned: learned || !!eb, src: learned ? 'focus' : eb ? 'energy' : 'default' };
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
const nudges = ({ meta, habits, cards, plan, pk, inPeak, online, limit = 2 }) => {
  const d = new Date(), now = d.getHours() + d.getMinutes() / 60, si = sleepInfo(meta), out = [], t = dayKey(0);
  const left = habits.filter((h) => !h.log.includes(t)).length, water = (meta.water || {})[t] || 0, wg = meta.waterGoal || 8;
  const toBed = (((si.bedTonight - now) % 24) + 24) % 24, past = (((now - si.bedTonight) % 24) + 24) % 24;
  if (meta.sleepStart) out.push({ icon: 'moon', text: 'Sleep timer is running. Open Sleep when you wake up.', go: 'sleep' });
  else if ((meta.sleep || {})[t] == null && now >= 6 && now < 14) out.push({ icon: 'bed-outline', text: `Log last night's sleep so your analytics stay accurate.`, go: 'sleep' });
  if (toBed <= 1.5) out.push({ icon: 'moon-outline', text: `Bedtime in ${Math.round(toBed * 60)} min. Start winding down.`, go: 'sleep' });
  else if (past <= 3) out.push({ icon: 'moon', text: `Past your ${fmt(si.bedTonight)} bedtime. Sleep now: tomorrow's output depends on it.`, go: 'sleep' });
  if (inPeak) out.push({ icon: 'flash', text: `You are in your peak window until ${fmt(pk.end)}. Do the hardest task now.`, go: 'focus' });
  else if (pk.start > now && pk.start - now <= 0.5) out.push({ icon: 'flash-outline', text: `Peak window starts in ${Math.round((pk.start - now) * 60)} min. Line up your hardest task.`, go: 'focus' });
  // Cross-tool links: what one tool logs changes what the others recommend
  const slept = (meta.sleep || {})[t], trained = (meta.workouts || []).some((w) => keyOf(w.ts) === t);
  if (slept != null && slept < 6 && !trained && now < 20) out.push({ icon: 'bed-outline', text: `Short night (${hm(slept)}). Keep training light and protect your peak window.`, go: 'workout' });
  const protein = sum((meta.food || []).filter((f) => keyOf(f.ts) === t).map((f) => f.p || 0)), ptarget = (meta.nut || {}).p || 0;
  if (trained && ptarget && protein < ptarget / 2 && now >= 15) out.push({ icon: 'nutrition-outline', text: `You trained today and protein is at ${Math.round(protein)} of ${ptarget} g. Feed the recovery.`, go: 'nutrition' });
  const moodNow = (meta.mood || {})[t];
  if (moodNow && (moodNow.e <= 2 || moodNow.m <= 2) && !((meta.calm || {})[t] > 0)) out.push({ icon: 'leaf-outline', text: 'Energy or mood is low. Two minutes of slow breathing first, then one small win.', go: 'breathe' });
  const cur = plan && plan.blocks.find((b) => !b.done && b.start <= now && now < b.end);
  if (cur) out.push({ icon: 'time-outline', text: `Now: ${cur.title} (until ${fmt(cur.end)})`, go: 'focus' });
  if (!plan && online && now < 20) out.push({ icon: 'sparkles-outline', text: 'No plan for today yet. Let Coach build one and apply it here.', go: 'plan' });
  if (left && now >= 18) out.push({ icon: 'flame-outline', text: `${left} habit${left > 1 ? 's' : ''} left today. Protect your streak.`, go: 'habits' });
  if (water < wg / 2 && now >= 14) out.push({ icon: 'water-outline', text: `Water is low: ${water}/${wg}.`, go: null });
  const due = cards.filter((c) => c.due <= t).length;
  if (due) out.push({ icon: 'albums-outline', text: `${due} flashcard${due > 1 ? 's' : ''} due for review.`, go: 'learn' });
  const ppl = meta.people || [], odp = ppl.filter((p) => dueIn(p) <= 0);
  if (odp.length) out.push({ icon: 'people-outline', text: `Reach out to ${odp[0].name}${odp.length > 1 ? ` and ${odp.length - 1} more` : ''}. Relationships compound.`, go: 'people' });
  const bds = ppl.map((p) => ({ p, n: bdayIn(p.bday) })).filter((x) => x.n !== null && x.n <= 3).sort((a, b) => a.n - b.n);
  if (bds.length) out.push({ icon: 'gift-outline', text: bds[0].n === 0 ? `${bds[0].p.name}'s birthday is today.` : `${bds[0].p.name}'s birthday is in ${bds[0].n} day${bds[0].n > 1 ? 's' : ''}.`, go: 'people' });
  const dec = (meta.decisions || []).filter((x) => !x.outcome && x.review <= t).length;
  if (dec) out.push({ icon: 'scale-outline', text: `${dec} decision${dec > 1 ? 's' : ''} ready to review. Calibrate your judgment.`, go: 'decisions' });
  if (now >= 20 && !(meta.shutdown || {})[t]) out.push({ icon: 'power-outline', text: 'Run your evening shutdown and set tomorrow up tonight.', go: 'shutdown' });
  const fs = meta.fast && meta.fast.start;
  if (fs && (Date.now() - fs) / 36e5 >= (meta.fast.goal || 16)) out.push({ icon: 'hourglass-outline', text: 'Your fasting goal is reached. End the fast when you are ready.', go: 'fasting' });
  const cdn = (meta.countdowns || []).filter((c) => { const n = daysUntil(c.date); return n >= 0 && n <= 3; });
  if (cdn.length) out.push({ icon: 'alarm-outline', text: `${cdn[0].title} is ${daysUntil(cdn[0].date) === 0 ? 'today' : `in ${daysUntil(cdn[0].date)} days`}.`, go: 'countdowns' });
  if ((meta.budget || 0) > 0 && spentIn(meta.expenses || [], monthKey(0)) > meta.budget) out.push({ icon: 'cash-outline', text: 'You are over your monthly budget.', go: 'expenses' });
  const rdone = ((((meta.routines || {}).done || {})[t] || {}).morning) || [], msteps = (meta.routines || {}).morning || DEFAULT_ROUTINES.morning;
  if (now >= 7 && now < 11 && rdone.length < msteps.length) out.push({ icon: 'sunny-outline', text: 'Your morning routine is not done yet.', go: 'routines' });
  return out.slice(0, limit);
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
    { id: 'lift10', icon: 'barbell-outline', name: 'Lifter', desc: 'Train on 10 different days', cur: new Set((meta.workouts || []).map((w) => keyOf(w.ts))).size, need: 10 },
    { id: 'calm60', icon: 'leaf-outline', name: 'Calm Mind', desc: '60 minutes of breathwork or meditation', cur: Math.floor(sum(Object.values(meta.calm || {}))), need: 60 },
    { id: 'books3', icon: 'library-outline', name: 'Bookworm', desc: 'Finish 3 books', cur: (meta.books || []).filter((b) => b.done).length, need: 3 },
    { id: 'skill10', icon: 'school-outline', name: 'Practitioner', desc: '10 hours of skill practice', cur: Math.floor(sum((meta.skills || []).map(skillMins)) / 60), need: 10 },
    { id: 'calib5', icon: 'scale-outline', name: 'Calibrated', desc: 'Review 5 decisions', cur: (meta.decisions || []).filter((d) => d.outcome).length, need: 5 },
    { id: 'notes25', icon: 'bulb-outline', name: 'Second Brain', desc: 'Capture 25 notes', cur: (meta.notes || []).length, need: 25 },
    { id: 'net5', icon: 'people-outline', name: 'Networker', desc: 'Track 5 important people', cur: (meta.people || []).length, need: 5 },
    { id: 'shut7', icon: 'power-outline', name: 'Closer', desc: 'Complete 7 evening shutdowns', cur: Object.keys(meta.shutdown || {}).length, need: 7 },
    { id: 'track10', icon: 'stopwatch-outline', name: 'Time Aware', desc: 'Track 10 time entries', cur: (meta.timeLog || []).length, need: 10 },
    { id: 'iron14', icon: 'ban-outline', name: 'Iron Will', desc: '14 clean days on a bad habit', cur: Math.max(0, ...(meta.anti || []).map((x) => daysBetween(x.slips.slice().sort().pop() || x.start, dayKey(0)))), need: 14 },
    { id: 'think12', icon: 'construct-outline', name: 'Thinker', desc: 'Apply 12 mental models', cur: Object.keys(meta.mmApplied || {}).length, need: 12 },
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
  unit: 'kg', nut: { cal: 2200, p: 140 }, cur: '$', budget: 0, awarded: {}, peakOverride: null,
};

/* ---------- Life OS: shared context, helpers, data libraries ---------- */
const AppCtx = React.createContext({});
const useApp = () => React.useContext(AppCtx);
const useMeta = (key, init) => {
  const { meta, setMeta } = useApp();
  const val = meta[key] ?? init;
  const set = (f) => setMeta((m) => ({ ...m, [key]: typeof f === 'function' ? f(m[key] ?? init) : f }));
  return [val, set];
};

const mondayKey = (off = 0) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + off * 7); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = (off = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const dateFrom = (k) => new Date(k + 'T12:00:00');
const validDate = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && keyOf(dateFrom(k).getTime()) === k;
const daysUntil = (k) => daysBetween(dayKey(0), k);
const num = (x, d = 0) => { const v = parseFloat(String(x == null ? '' : x).replace(',', '.')); return Number.isFinite(v) ? v : d; };
const r1 = (x) => Math.round(x * 10) / 10;
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (v, cur = '$') => { const a = Math.abs(v), t = a < 100 && a % 1 ? a.toFixed(2) : commas(Math.round(a)); return `${v < 0 ? '-' : ''}${cur}${t}`; };
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const dayOfYear = () => { const d = new Date(), s = new Date(d.getFullYear(), 0, 0); return Math.floor((d - s) / 864e5); };
const pruneDays = (o, keep = 60) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => b.localeCompare(a)).slice(0, keep));

/* Fitness and money maths */
const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30));
const tdee = (sex, age, h, w, act) => Math.round((10 * w + 6.25 * h - 5 * age + (sex === 'm' ? 5 : -161)) * act);
const futureValue = (p, c, rate, years) => {
  const n = Math.round(years * 12), i = rate / 100 / 12;
  if (!n) return p;
  if (!i) return p + c * n;
  const g = Math.pow(1 + i, n);
  return p * g + c * ((g - 1) / i);
};
const yearsToTarget = (target, p, c, rate) => {
  const i = rate / 100 / 12;
  let bal = p;
  for (let m = 0; m <= 1200; m++) { if (bal >= target) return m / 12; bal = bal * (1 + i) + c; }
  return null;
};
const spentIn = (exp, mk) => sum(exp.filter((e) => keyOf(e.ts).slice(0, 7) === mk).map((e) => e.amt));
const daysLeftMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1; };
const subMonthly = (x) => (x.cycle === 'year' ? x.amt / 12 : x.amt);
const nextDay = (dom) => {
  const now = new Date(), dim = (y, m) => new Date(y, m + 1, 0).getDate();
  let y = now.getFullYear(), m = now.getMonth(), t = new Date(y, m, Math.min(dom, dim(y, m)), 12);
  if (keyOf(t.getTime()) < dayKey(0)) { m += 1; if (m > 11) { m = 0; y += 1; } t = new Date(y, m, Math.min(dom, dim(y, m)), 12); }
  return daysBetween(dayKey(0), keyOf(t.getTime()));
};

/* Thinking and relationships */
const calib = (ds) => {
  const res = ds.filter((d) => d.outcome);
  if (!res.length) return null;
  const hit = res.filter((d) => d.outcome === 'right').length + 0.5 * res.filter((d) => d.outcome === 'mixed').length;
  const rate = (100 * hit) / res.length, conf = sum(res.map((d) => d.conf)) / res.length;
  return { n: res.length, rate: Math.round(rate), conf: Math.round(conf), gap: Math.round(conf - rate) };
};
const dueIn = (p) => (p.last ? p.cadence - daysBetween(p.last, dayKey(0)) : 0);
const normMD = (x) => { const m = /^(\d{1,2})[-/](\d{1,2})$/.exec(String(x).trim()); if (!m) return ''; const mo = +m[1], d = +m[2]; return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${pad(mo)}-${pad(d)}` : ''; };
const bdayIn = (md) => {
  const m = /^(\d{2})-(\d{2})$/.exec(md || '');
  if (!m) return null;
  const y = new Date().getFullYear();
  let n = new Date(y, +m[1] - 1, +m[2], 12);
  if (keyOf(n.getTime()) < dayKey(0)) n = new Date(y + 1, +m[1] - 1, +m[2], 12);
  return daysBetween(dayKey(0), keyOf(n.getTime()));
};
const lifeStats = (birth, exp) => {
  const days = Math.floor((Date.now() - dateFrom(birth).getTime()) / 864e5), weeks = Math.max(0, Math.floor(days / 7)), total = exp * 52;
  return { days, weeks, total, left: Math.max(0, total - weeks), pct: Math.round(1000 * clamp(weeks / total)) / 10, years: Math.max(0, Math.min(exp, days / 365.25)) };
};
const skillMins = (sk) => sum(Object.values(sk.log || {}));

/* Energy map */
const energyByHour = (log) => { const by = {}; log.forEach((e) => { const h = new Date(e.ts).getHours(); (by[h] = by[h] || []).push(e.v); }); const out = {}; Object.keys(by).forEach((h) => { out[h] = sum(by[h]) / by[h].length; }); return out; };
const bestEnergy = (log) => {
  if (log.length < 10) return null;
  const av = energyByHour(log);
  let best = null;
  for (let h = 5; h <= 21; h++) {
    if (av[h] === undefined || av[h + 1] === undefined) continue;
    const sc = (av[h] + av[h + 1]) / 2;
    if (!best || sc > best.score + 1e-9) best = { start: h, end: h + 2, score: r1(sc) };
  }
  return best;
};

/* Breathwork and games */
const BREATH = {
  box: { name: 'Box 4-4-4-4', note: 'Steadies the nervous system before hard work.', ph: [['Inhale', 4, 1], ['Hold', 4, 1], ['Exhale', 4, 0], ['Hold', 4, 0]] },
  calm: { name: '4-7-8 calm', note: 'A long exhale to wind down or fall asleep.', ph: [['Inhale', 4, 1], ['Hold', 7, 1], ['Exhale', 8, 0]] },
  sigh: { name: 'Physiological sigh', note: 'Two sips in, one long breath out. Fast stress relief.', ph: [['Inhale', 2, 1], ['Sip in', 1, 1], ['Long exhale', 6, 0]] },
  even: { name: 'Coherent 5-5', note: 'Smooth, even breathing for steady focus.', ph: [['Inhale', 5, 1], ['Exhale', 5, 0]] },
};
const breathAt = (ph, ms) => {
  const L = sum(ph.map((p) => p[1])) * 1000, pos = ms % L;
  let acc = 0;
  for (let i = 0; i < ph.length; i++) {
    const d = ph[i][1] * 1000;
    if (pos < acc + d) { const prev = ph[(i - 1 + ph.length) % ph.length][2]; return { i, label: ph[i][0], left: Math.ceil((acc + d - pos) / 1000), fill: prev + (ph[i][2] - prev) * ((pos - acc) / d) }; }
    acc += d;
  }
  return { i: 0, label: ph[0][0], left: ph[0][1], fill: 0 };
};
const mathQ = (lvl) => {
  let a, b, op;
  const swap = () => { if (b > a) { const t = a; a = b; b = t; } };
  if (lvl <= 0) { a = ri(2, 20); b = ri(2, 20); op = Math.random() < 0.5 ? '+' : '-'; if (op === '-') swap(); }
  else if (lvl === 1) { a = ri(12, 99); b = ri(12, 99); op = Math.random() < 0.5 ? '+' : '-'; if (op === '-') swap(); }
  else if (lvl === 2) { a = ri(2, 12); b = ri(2, 12); op = '\u00D7'; }
  else if (lvl === 3) { if (Math.random() < 0.5) { a = ri(11, 49); b = ri(3, 9); op = '\u00D7'; } else { b = ri(3, 12); a = b * ri(3, 15); op = '\u00F7'; } }
  else if (Math.random() < 0.35) { a = ri(12, 29); b = ri(6, 19); op = '\u00D7'; }
  else { a = ri(101, 499); b = ri(11, 99); op = Math.random() < 0.5 ? '+' : '-'; if (op === '-') swap(); }
  const ans = op === '+' ? a + b : op === '-' ? a - b : op === '\u00D7' ? a * b : a / b;
  return { text: `${a} ${op} ${b}`, ans };
};
const STROOP = [['RED', '#F87171'], ['BLUE', '#60A5FA'], ['GREEN', '#4ADE80'], ['YELLOW', '#FBBF24']];
const stroopQ = () => { const w = ri(0, 3); let c = ri(0, 3); if (c === w && Math.random() < 0.75) c = (c + ri(1, 3)) % 4; return { word: STROOP[w][0], ink: c }; };
const wordDelay = (chunk, wpm) => ((60000 / wpm) * chunk.split(' ').length) * (/[.!?]["')\]]?$/.test(chunk) ? 1.8 : /[,;:]$/.test(chunk) ? 1.3 : 1);
const SAMPLE_TEXT = 'Reading speed is mostly a habit, not a limit. Most people read at the pace they learned as children, silently pronouncing every word. Your eyes can take in far more than your inner voice can say. Training yourself to see words in short groups, and to stop rereading, can raise your pace without hurting understanding. Start at a speed that feels slightly too fast, keep your attention on the meaning, and increase the pace a little each week. Afterwards, summarize what you read in one sentence. If you cannot, slow down for the next session.';

/* Leverage insights: which behaviours go with your best days */
const leverInsights = (meta, activity, habits) => {
  const first = Object.keys(activity).sort()[0];
  if (!first) return { rows: [], days: 0 };
  const days = lastDays(60).filter((d) => d >= first);
  const tg = meta.sleepTarget || 8, wg = meta.waterGoal || 8, rt = meta.routines || {}, nut = meta.nut || {};
  const wk = new Set((meta.workouts || []).map((w) => keyOf(w.ts))), jr = new Set((meta.journal || []).map((j) => j.date));
  const food = {};
  (meta.food || []).forEach((f) => { const k = keyOf(f.ts); food[k] = (food[k] || 0) + (f.p || 0); });
  const stepsDone = (d, kind) => { const steps = (rt[kind] || DEFAULT_ROUTINES[kind]), done = (((rt.done || {})[d] || {})[kind]) || []; return steps.length > 0 && steps.every((x) => done.includes(x.id)); };
  const F = [
    { id: 'sleep', label: `Sleeping ${tg}h or more`, has: (d) => ((meta.sleep || {})[d] || 0) >= tg, habit: `Sleep ${tg}+ hours`, cat: 'body' },
    { id: 'water', label: 'Hitting your water goal', has: (d) => ((meta.water || {})[d] || 0) >= wg, habit: 'Hit my water goal', cat: 'body' },
    { id: 'workout', label: 'Training', has: (d) => wk.has(d), habit: 'Train', cat: 'body' },
    { id: 'calm', label: '5+ minutes of calm practice', has: (d) => ((meta.calm || {})[d] || 0) >= 5, habit: 'Breathe or meditate 5 minutes', cat: 'mind' },
    { id: 'journal', label: 'Journaling', has: (d) => jr.has(d), habit: 'Journal', cat: 'mind' },
    { id: 'plan', label: 'Having a plan', has: (d) => !!(meta.plans || {})[d], habit: 'Plan my day', cat: 'discipline' },
    { id: 'focus', label: '25+ minutes of deep focus', has: (d) => ((meta.focusDays || {})[d] || 0) >= 25, habit: 'Do a deep focus session', cat: 'career' },
    { id: 'morning', label: 'Finishing your morning routine', has: (d) => stepsDone(d, 'morning'), habit: 'Complete my morning routine', cat: 'discipline' },
    { id: 'protein', label: 'Hitting your protein target', has: (d) => !!nut.p && (food[d] || 0) >= nut.p, habit: 'Hit my protein target', cat: 'body' },
  ];
  const avg = (a) => sum(a.map((d) => activity[d] || 0)) / a.length;
  const rows = F.map((f) => {
    const w = days.filter(f.has), wo = days.filter((d) => !f.has(d));
    if (w.length < 3 || wo.length < 3) return null;
    return { id: f.id, label: f.label, habit: f.habit, cat: f.cat, delta: r1(avg(w) - avg(wo)), nWith: w.length, nWithout: wo.length, withAvg: r1(avg(w)), withoutAvg: r1(avg(wo)) };
  }).filter(Boolean).sort((a, b) => b.delta - a.delta);
  return { rows, days: days.length };
};

/* Offline auto-planner: builds a realistic time-blocked day from your own data, no AI needed */
function autoPlan({ nowH, off, wake, bed, pk, tasks, habits, due }) {
  const start = off ? wake : Math.max(nowH, wake);
  const bedH = bed < wake ? bed + 24 : bed, wd = Math.min(bedH - 1, 23), limit = wd;
  if (start >= limit - 0.5) return null;
  const today = dayKey(0), B = [];
  const place = (s, e, title, cat, ref) => {
    s = Math.max(s, start); e = Math.min(e, limit);
    if (e - s < 0.25 || B.some((b) => s < b.end && e > b.start)) return false;
    B.push({ start: s, end: e, title, cat, ref: ref || '' });
    return true;
  };
  const open = tasks.filter((t) => !t.done).sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0));
  const top = open[0], second = open[1];
  B.push({ start: wd, end: Math.min(wd + 0.75, 24), title: 'Wind down and prepare for sleep', cat: 'mind', ref: '' });
  const deep = top ? `Deep work: ${top.title}` : 'Deep work: your most important output';
  if (!place(pk.start, Math.min(pk.end, pk.start + 2), deep, top ? top.cat : 'career', top && top.title)) place(start + 0.25, start + 2.25, deep, top ? top.cat : 'career', top && top.title);
  place(12.5, 13, 'Lunch and a short walk', 'body');
  place(18.5, 19.25, 'Dinner', 'body');
  if (off || start <= wake + 0.5) place(wake, wake + 0.5, 'Morning routine and water', 'mind');
  const bodyHabit = habits.find((h) => h.cat === 'body' && (off || !h.log.includes(today)));
  const trainTitle = bodyHabit ? bodyHabit.title : 'Move: 30 minutes of training or a brisk walk';
  const ts = Math.max(start, wake + 0.5);
  if (!(pk.start - ts >= 0.75 && place(ts, ts + 0.75, trainTitle, 'body', bodyHabit && bodyHabit.title))) place(17, 17.75, trainTitle, 'body', bodyHabit && bodyHabit.title);
  if (second) place(14, 15.5, `Focus: ${second.title}`, second.cat, second.title);
  if (due > 0) place(15.75, 16.15, `Flashcard review (${due} due)`, 'academics');
  const rest = open.length - (top ? 1 : 0) - (second ? 1 : 0);
  if (rest > 0) place(16.25, 17, `Clear small tasks (${rest})`, 'discipline');
  habits.filter((h) => h !== bodyHabit && (off || !h.log.includes(today))).slice(0, 3).forEach((h) => {
    for (let t = 19.25; t < limit - 0.25; t += 0.25) if (place(t, t + 0.25, h.title, h.cat, h.title)) break;
  });
  B.sort((a, b) => a.start - b.start);
  return B.length >= 2 ? normPlan(B, [], top ? top.title : '') : null;
}

const DEFAULT_ROUTINES = {
  morning: [{ id: 'm1', text: 'Drink a glass of water' }, { id: 'm2', text: '10 minutes of daylight or movement' }, { id: 'm3', text: 'Review your plan and pick the one thing' }, { id: 'm4', text: 'Keep your phone away until the first focus block' }],
  evening: [{ id: 'e1', text: 'Write tomorrow\'s top tasks' }, { id: 'e2', text: 'Tidy your space and prep for tomorrow' }, { id: 'e3', text: 'Screens off 30 minutes before bed' }, { id: 'e4', text: 'Read 10 pages' }],
};

const MODELS = [
  { id: 'first', name: 'First principles', tip: 'Break a problem into basic truths and rebuild from there instead of copying what others do.', ask: 'What do I know for certain, and what am I only assuming?' },
  { id: 'inversion', name: 'Inversion', tip: 'Ask how to guarantee failure, then avoid exactly that.', ask: 'What would make this fail for sure?' },
  { id: 'second', name: 'Second-order thinking', tip: 'Consider the consequences of the consequences, not just the first result.', ask: 'And then what? And then what?' },
  { id: 'pareto', name: 'Pareto principle', tip: 'A small share of inputs creates most of the results.', ask: 'Which 20% of my actions drive 80% of my results?' },
  { id: 'opp', name: 'Opportunity cost', tip: 'Every yes is a no to something else.', ask: 'What am I giving up by choosing this?' },
  { id: 'circle', name: 'Circle of competence', tip: 'Know the edge of what you truly understand and respect it.', ask: 'Do I really know this, or do I just recognize it?' },
  { id: 'compound', name: 'Compounding', tip: 'Small gains repeated daily beat big efforts made once.', ask: 'What tiny daily action would be huge in a year?' },
  { id: 'margin', name: 'Margin of safety', tip: 'Build a buffer for what you cannot predict.', ask: 'If I am wrong by 30%, do I still survive?' },
  { id: 'occam', name: "Occam's razor", tip: 'Prefer the simplest explanation that fits the facts.', ask: 'What is the simplest explanation?' },
  { id: 'hanlon', name: "Hanlon's razor", tip: 'Do not assume malice when neglect or error explains it.', ask: 'What is the most charitable explanation?' },
  { id: 'map', name: 'Map is not the territory', tip: 'Your model of reality is not reality. Update it.', ask: 'Where might my picture be out of date?' },
  { id: 'negativa', name: 'Via negativa', tip: 'Improve by removing, not by adding.', ask: 'What could I stop doing that would make things better?' },
  { id: 'bayes', name: 'Bayesian updating', tip: 'Change your beliefs in proportion to the strength of new evidence.', ask: 'What would change my mind, and by how much?' },
  { id: 'anti', name: 'Antifragility', tip: 'Seek systems that gain from stress and volatility.', ask: 'How can this setback make me stronger?' },
  { id: 'lindy', name: 'Lindy effect', tip: 'The longer something has lasted, the longer it will likely last.', ask: 'Is this a fad or has it survived for decades?' },
  { id: 'sunk', name: 'Sunk cost', tip: 'Past investment is gone. Decide based on the future.', ask: 'If I were starting fresh today, would I choose this?' },
  { id: 'regret', name: 'Regret minimization', tip: 'Choose what your 80-year-old self would approve of.', ask: 'Which choice will I regret least?' },
  { id: 'eisen', name: 'Eisenhower matrix', tip: 'Important is rarely urgent, and urgent is rarely important.', ask: 'Is this important, urgent, both or neither?' },
  { id: 'feynman', name: 'Feynman technique', tip: 'If you cannot explain it simply, you do not understand it yet.', ask: 'Can I explain this to a 12-year-old?' },
  { id: 'leverage', name: 'Leverage', tip: 'Use systems, tools and other people to multiply output.', ask: 'What can I automate, delegate or template?' },
  { id: 'parkinson', name: "Parkinson's law", tip: 'Work expands to fill the time you give it.', ask: 'What shorter deadline would force focus?' },
  { id: 'premortem', name: 'Pre-mortem', tip: 'Imagine the project already failed and work out why.', ask: 'It is a year from now and this failed. Why?' },
  { id: 'twomin', name: 'Two-minute rule', tip: 'If it takes under two minutes, do it now.', ask: 'Can I finish this in two minutes?' },
  { id: 'goodhart', name: "Goodhart's law", tip: 'When a measure becomes a target, it stops being a good measure.', ask: 'Am I optimizing the metric or the real goal?' },
];

const PLAYBOOKS = [
  { g: 'Think better', t: 'First-principles teardown', p: 'Run a first-principles teardown on this problem. Separate facts from assumptions, then rebuild the best solution from the facts: ' },
  { g: 'Think better', t: 'Inversion and pre-mortem', p: 'Use inversion and a pre-mortem on this plan. List how it fails, rank by likelihood and damage, and give me prevention steps: ' },
  { g: 'Think better', t: 'Steelman the other side', p: 'Steelman the strongest opposing view to my position, then tell me what I might be missing: ' },
  { g: 'Think better', t: 'Second-order effects', p: 'Map the first, second and third-order consequences of this decision: ' },
  { g: 'Learn faster', t: '20-hour skill roadmap', p: 'Design a 20-hour roadmap to get functionally good at this skill: deconstruct it, name what to learn first, and give me a practice schedule that fits my week: ' },
  { g: 'Learn faster', t: 'Feynman teach-back', p: 'Quiz me with the Feynman technique. Ask me to explain this topic simply, find the gaps in my explanation, and make me fix them: ' },
  { g: 'Learn faster', t: 'Exam sprint plan', p: 'Build a spaced-repetition exam sprint plan for me. Subject and exam date: ' },
  { g: 'Learn faster', t: 'Book to action plan', p: 'Turn this book into a one-page action plan: the 5 key ideas, how each applies to my life, and what to do this week: ' },
  { g: 'Performance', t: 'Diagnose my procrastination', auto: true, p: 'Diagnose my procrastination using my real data (tasks, habits, focus, sleep, energy). Name the most likely root cause and give me three small experiments for this week.' },
  { g: 'Performance', t: 'Design a keystone habit', p: 'Design a keystone habit for me with a clear cue, a 2-minute version and a reward. The goal I want it to serve: ' },
  { g: 'Performance', t: 'Energy audit', auto: true, p: 'Run an energy audit from my sleep, energy log, workouts and routine. Where am I leaking energy, and what are the three highest-leverage changes?' },
  { g: 'Performance', t: 'Burnout check', auto: true, p: 'Check me for burnout risk from my recent workload, sleep debt, breaks and mood. Be honest, and give me a recovery plan if needed.' },
  { g: 'Life design', t: 'Quarterly reset', auto: true, p: 'Run a quarterly life reset with me: review my goals, life wheel, habits and finances, name what to stop, start and continue, and set 3 outcomes for the next 90 days.' },
  { g: 'Life design', t: 'Weekly OKRs', auto: true, p: 'Write my weekly OKRs: 3 objectives with measurable key results, based on my goals, projects and open tasks.' },
  { g: 'Life design', t: 'Hard conversation script', p: 'Help me prepare for a hard conversation. Give me an opening line, key points, likely reactions and how to respond. The situation: ' },
  { g: 'Career and money', t: 'Interview prep', p: 'Prepare me for this interview with likely questions, strong answer structures and smart questions to ask. Role and company: ' },
  { g: 'Career and money', t: 'Negotiation prep', p: 'Prepare my negotiation: my best alternative, their likely interests, an opening offer and the lines to use. The situation: ' },
  { g: 'Career and money', t: 'Money leak finder', auto: true, p: 'Review my expenses, subscriptions and budget. Find the biggest leaks, what to cut, and a simple plan to save more each month.' },
  { g: 'Body', t: 'Training plan from my data', auto: true, p: 'Design my next 4 weeks of training from my workout log, recovery and goals. Keep it realistic for my schedule.' },
  { g: 'Body', t: 'Meal plan for my targets', auto: true, p: 'Build a simple 3-day meal plan that hits my calorie and protein targets. Keep it cheap and quick to cook.' },
  { g: 'Relationships', t: 'Reach-out messages', auto: true, p: 'Draft short, warm messages to the people on my overdue list so I can reconnect today.' },
];

const REG = [
  { id: 'sleep', g: 'Body', icon: 'moon-outline', name: 'Sleep', desc: 'Timer, sleep debt and bedtime coaching' },
  { id: 'workout', g: 'Body', icon: 'barbell-outline', name: 'Workouts', desc: 'Sets, reps and PR tracking' },
  { id: 'nutrition', g: 'Body', icon: 'nutrition-outline', name: 'Nutrition', desc: 'Calories, protein and a target calculator' },
  { id: 'body', g: 'Body', icon: 'body-outline', name: 'Body metrics', desc: 'Weight and waist trends' },
  { id: 'fasting', g: 'Body', icon: 'hourglass-outline', name: 'Fasting', desc: 'Fasting timer and history' },
  { id: 'breathe', g: 'Body', icon: 'leaf-outline', name: 'Breathwork', desc: 'Guided patterns to calm or focus' },
  { id: 'meditate', g: 'Body', icon: 'flower-outline', name: 'Meditation', desc: 'Silent timer with a streak' },
  { id: 'math', g: 'Brain', icon: 'calculator-outline', name: 'Math sprint', desc: '60-second mental arithmetic' },
  { id: 'stroop', g: 'Brain', icon: 'color-palette-outline', name: 'Stroop drill', desc: 'Train attention control' },
  { id: 'speed', g: 'Brain', icon: 'eye-outline', name: 'Speed reader', desc: 'Read faster, one chunk at a time' },
  { id: 'books', g: 'Brain', icon: 'library-outline', name: 'Reading list', desc: 'Progress, pace and takeaways' },
  { id: 'notes', g: 'Brain', icon: 'bulb-outline', name: 'Second brain', desc: 'Searchable notes and ideas' },
  { id: 'models', g: 'Brain', icon: 'construct-outline', name: 'Mental models', desc: 'A new thinking tool every day' },
  { id: 'decisions', g: 'Brain', icon: 'scale-outline', name: 'Decision journal', desc: 'Calibrate your judgment' },
  { id: 'decide', g: 'Brain', icon: 'options-outline', name: 'Decision matrix', desc: 'Weighted scoring of your options' },
  { id: 'premortem', g: 'Brain', icon: 'warning-outline', name: 'Pre-mortem', desc: 'Find failure before it happens' },
  { id: 'priority', g: 'Execute', icon: 'grid-outline', name: 'Priority matrix', desc: 'Urgent versus important' },
  { id: 'big3', g: 'Execute', icon: 'podium-outline', name: 'Weekly Big 3', desc: 'Three outcomes that make the week' },
  { id: 'projects', g: 'Execute', icon: 'folder-open-outline', name: 'Projects', desc: 'Next actions and stall alerts' },
  { id: 'routines', g: 'Execute', icon: 'sunny-outline', name: 'Routines', desc: 'Morning and evening checklists' },
  { id: 'timetrack', g: 'Execute', icon: 'stopwatch-outline', name: 'Time tracker', desc: 'See where your hours really go' },
  { id: 'energy', g: 'Execute', icon: 'battery-charging-outline', name: 'Energy map', desc: 'Find your real peak hours' },
  { id: 'shutdown', g: 'Execute', icon: 'power-outline', name: 'Evening shutdown', desc: 'Set tomorrow up tonight' },
  { id: 'anti', g: 'Execute', icon: 'ban-outline', name: 'Break bad habits', desc: 'Track what you refuse to do' },
  { id: 'countdowns', g: 'Execute', icon: 'alarm-outline', name: 'Countdowns', desc: 'Deadlines and events' },
  { id: 'goals', g: 'Execute', icon: 'trophy-outline', name: 'Goals', desc: 'Big targets with progress' },
  { id: 'briefing', g: 'Intelligence', icon: 'newspaper-outline', name: 'Daily briefing', desc: 'Everything that matters today' },
  { id: 'levers', g: 'Intelligence', icon: 'analytics-outline', name: 'Leverage insights', desc: 'What drives your best days' },
  { id: 'playbooks', g: 'Intelligence', icon: 'sparkles-outline', name: 'Coach playbooks', desc: 'Expert prompts in one tap' },
  { id: 'search', g: 'Intelligence', icon: 'search-outline', name: 'Search everything', desc: 'Find any task, note or entry' },
  { id: 'review', g: 'Intelligence', icon: 'document-text-outline', name: 'Weekly review', desc: 'Your week in numbers' },
  { id: 'retro', g: 'Intelligence', icon: 'refresh-circle-outline', name: 'Weekly retro', desc: 'What worked, what to change' },
  { id: 'expenses', g: 'Money', icon: 'cash-outline', name: 'Expenses', desc: 'Spending, budget and daily allowance' },
  { id: 'subs', g: 'Money', icon: 'card-outline', name: 'Subscriptions', desc: 'What you pay every month and year' },
  { id: 'networth', g: 'Money', icon: 'trending-up-outline', name: 'Net worth', desc: 'Assets, debts and monthly trend' },
  { id: 'calc', g: 'Money', icon: 'calculator-outline', name: 'Wealth calculators', desc: 'Compounding, FI number, time is money' },
  { id: 'skills', g: 'Growth', icon: 'school-outline', name: 'Skill tracker', desc: 'Deliberate practice hours' },
  { id: 'people', g: 'Growth', icon: 'people-outline', name: 'People', desc: 'Relationship reminders and birthdays' },
  { id: 'principles', g: 'Growth', icon: 'compass-outline', name: 'Principles', desc: 'Your rules and identity' },
  { id: 'journal', g: 'Growth', icon: 'book-outline', name: 'Journal', desc: 'Daily prompts and streak' },
  { id: 'wins', g: 'Growth', icon: 'medal-outline', name: 'Wins vault', desc: 'Proof you can do hard things' },
  { id: 'wheel', g: 'Growth', icon: 'aperture-outline', name: 'Life wheel', desc: 'Rate 8 areas of life' },
  { id: 'lifeweeks', g: 'Growth', icon: 'time-outline', name: 'Life in weeks', desc: 'Your time, made visible' },
  { id: 'bucket', g: 'Growth', icon: 'checkbox-outline', name: 'Bucket list', desc: 'Things you will not skip' },
  { id: 'badges', g: 'Growth', icon: 'ribbon-outline', name: 'Badges', desc: 'Unlocked from real activity' },
];
const regOf = (id) => REG.find((r) => r.id === id);

/* ---------- Small UI kit for the new screens ---------- */
function Inp({ value, onChange, ph, num: isNum, multi, onSubmit, style, editable }) {
  return (
    <TextInput
      style={[s.addInput, { flex: 0, marginBottom: 8 }, multi && { minHeight: 90, textAlignVertical: 'top' }, style]}
      value={value} onChangeText={onChange} placeholder={ph} placeholderTextColor={C.muted} keyboardAppearance="dark"
      keyboardType={isNum ? 'decimal-pad' : 'default'} multiline={!!multi} onSubmitEditing={onSubmit} editable={editable !== false}
    />
  );
}
function Btn({ label, onPress, kind, disabled, icon, style }) {
  const primary = kind !== 'ghost' && kind !== 'danger';
  const bg = disabled ? C.disabled : kind === 'danger' ? '#B91C1C' : primary ? C.accent : '#17171A';
  const fg = disabled ? '#6B6B73' : primary ? C.onAccent : kind === 'danger' ? '#fff' : C.text;
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[s.wide, { backgroundColor: bg, marginTop: 8 }, style]}>
      <View style={s.btnRow}>{!!icon && <Icon n={icon} size={18} color={fg} style={{ marginRight: 8 }} />}<Text style={[s.addBtnText, { color: fg }]}>{label}</Text></View>
    </Pressable>
  );
}
function Chips({ opts, value, onChange, show }) {
  return (
    <View style={s.chipRow}>
      {opts.map((o) => (
        <Pressable key={String(o)} onPress={() => onChange(o)} style={[s.chip, { paddingVertical: 6 }, value === o && { borderColor: C.accent, backgroundColor: C.raised }]}>
          <Text style={s.chipText}>{show ? show(o) : String(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}
const Bar = ({ pct, color = C.accent }) => <View style={s.track}><View style={[s.fill, { width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: color }]} /></View>;
function Row({ title, sub, right, onDelete, onPress, check, done, accent }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={s.item}>
      {check !== undefined && <View style={[s.check, { borderColor: accent || C.muted }, done && { backgroundColor: accent || C.online }]}>{done && <Icon n="checkmark" size={16} color="#000" />}</View>}
      <View style={{ flex: 1 }}>
        <Text style={[s.itemText, { flex: 0 }, done && s.done]}>{title}</Text>
        {!!sub && <Text style={s.muted}>{sub}</Text>}
      </View>
      {right ? <View style={{ marginLeft: 8 }}>{right}</View> : null}
      {!!onDelete && <Pressable onPress={onDelete} hitSlop={10}><Icon n="close" size={18} color={C.muted} style={{ marginLeft: 10 }} /></Pressable>}
    </Pressable>
  );
}
const Label = ({ children, style }) => <Text style={[s.muted, { marginTop: 10, marginBottom: 4 }, style]}>{children}</Text>;

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
  const A = useApp();
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack || (() => A.go(A.backTo || 'today'))} hitSlop={10} style={[s.btnRow, { alignSelf: 'flex-start', marginBottom: 8 }]}>
        <Icon n="chevron-back" size={18} color={C.muted} /><Text style={[s.muted, { marginLeft: 2 }]}>{TAB_NAME[A.backTo] || 'Today'}</Text>
      </Pressable>
      <Text style={s.h1}>{title}</Text>
      {!!sub && <Text style={[s.muted, { marginTop: 4, marginBottom: 12 }]}>{sub}</Text>}
      {children}
      <Links id={A.tool} />
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
      <TextInput style={[s.addInput, { flex: 0, marginBottom: 8 }]} value={title} onChangeText={setTitle} placeholder="Goal (e.g. Read 12 books)" placeholderTextColor={C.muted} keyboardAppearance="dark" />
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
      <TextInput style={[s.addInput, { flex: 0, minHeight: 130, textAlignVertical: 'top' }]} value={text} onChangeText={setText} multiline placeholder="Write freely. This stays on your device." placeholderTextColor={C.muted} keyboardAppearance="dark" />
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


/* ---------- Body: workouts, nutrition, metrics, fasting, calm ---------- */
function UnitChips() {
  const { meta, setMeta } = useApp();
  return <Chips opts={['kg', 'lb']} value={meta.unit || 'kg'} onChange={(u) => setMeta((m) => ({ ...m, unit: u }))} />;
}

function Workout() {
  const A = useApp();
  const [sets, setSets] = useMeta('workouts', []);
  const unit = A.meta.unit || 'kg';
  const [ex, setEx] = useState(''), [w, setW] = useState('60'), [r, setR] = useState('8');
  const today = dayKey(0);
  const todays = sets.filter((x) => keyOf(x.ts) === today);
  const names = [...new Set(sets.map((x) => x.ex))].slice(0, 8);
  const best = (name) => Math.max(0, ...sets.filter((x) => x.ex === name).map((x) => e1rm(x.w, x.r)));
  const pick = (name) => { setEx(name); const l = sets.find((x) => x.ex === name); if (l) { setW(String(l.w)); setR(String(l.r)); } };
  const add = () => {
    const name = ex.trim(), wt = num(w), rp = Math.round(num(r));
    if (!name || rp < 1 || wt < 0) return;
    const prior = best(name), now = e1rm(wt, rp);
    setSets((l) => [{ id: uid(), ts: Date.now(), ex: name, w: wt, r: rp }, ...l].slice(0, 2000));
    A.award('workout', 8);
    if (prior > 0 && now > prior + 0.01) A.toast(`New PR on ${name}: about ${r1(now)} ${unit} estimated 1RM`);
  };
  const groups = {};
  todays.slice().reverse().forEach((x) => { (groups[x.ex] = groups[x.ex] || []).push(x); });
  const vol = sum(todays.map((x) => x.w * x.r));
  const prs = [...new Set(sets.map((x) => x.ex))].map((n) => ({ n, v: best(n) })).sort((a, b) => b.v - a.v).slice(0, 6);
  const week = lastDays(7).slice().reverse().map((d) => ({ d, v: sum(sets.filter((x) => keyOf(x.ts) === d).map((x) => x.w * x.r)) }));
  const mx = Math.max(1, ...week.map((x) => x.v));
  return (
    <Screen title="Workouts" sub="Log sets as you train. Beat your estimated 1RM and the app flags a PR." onBack={undefined}>
      <UnitChips />
      <Inp value={ex} onChange={setEx} ph="Exercise (e.g. Back squat)" />
      {names.length > 0 && <View style={s.chipRow}>{names.map((n) => <Pressable key={n} onPress={() => pick(n)} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>{n}</Text></Pressable>)}</View>}
      <View style={{ flexDirection: 'row' }}>
        <Inp value={w} onChange={setW} num ph={`Weight (${unit})`} style={{ flex: 1, marginRight: 8 }} />
        <Inp value={r} onChange={setR} num ph="Reps" style={{ flex: 1 }} />
      </View>
      <View style={[s.btnRow, { justifyContent: 'flex-start', marginBottom: 4 }]}>
        {[['\u22122.5', -2.5], ['+2.5', 2.5], ['+5', 5]].map(([l, d]) => <Pressable key={l} onPress={() => setW(String(Math.max(0, r1(num(w) + d))))} style={[s.stepBtn, { marginRight: 8 }]}><Text style={s.chipText}>{l}</Text></Pressable>)}
        {[['\u22121 rep', -1], ['+1 rep', 1]].map(([l, d]) => <Pressable key={l} onPress={() => setR(String(Math.max(1, Math.round(num(r)) + d)))} style={[s.stepBtn, { marginRight: 8 }]}><Text style={s.chipText}>{l}</Text></Pressable>)}
      </View>
      <Btn label="Log set" icon="add" onPress={add} disabled={!ex.trim()} />
      <Text style={s.section}>Today · {todays.length} sets · {commas(Math.round(vol))} {unit} volume</Text>
      {todays.length === 0 && <Text style={s.empty}>No sets logged yet today.</Text>}
      {Object.keys(groups).map((n) => (
        <View key={n} style={s.card}>
          <Text style={[s.habitTitle, { flex: 0 }]}>{n}</Text>
          {groups[n].map((x, i) => (
            <View key={x.id} style={[s.between, { marginTop: 8 }]}>
              <Text style={s.muted}>Set {i + 1}: {x.w} {unit} × {x.r}  (≈{r1(e1rm(x.w, x.r))} 1RM)</Text>
              <Pressable onPress={() => setSets((l) => l.filter((y) => y.id !== x.id))} hitSlop={10}><Icon n="close" size={16} color={C.muted} /></Pressable>
            </View>
          ))}
        </View>
      ))}
      <Text style={s.section}>Volume, last 7 days</Text>
      <View style={s.card}>
        <View style={s.bars}>
          {week.map((x) => (
            <View key={x.d} style={s.barCol}>
              <View style={[s.bar, { height: 4 + (x.v / mx) * 70, backgroundColor: x.d === today ? C.accent : '#3A3A3F' }]} />
              <Text style={s.barLbl}>{'SMTWTFS'[dateFrom(x.d).getDay()]}</Text>
            </View>
          ))}
        </View>
      </View>
      {prs.length > 0 && <Text style={s.section}>Personal records (estimated 1RM)</Text>}
      {prs.map((p) => <Row key={p.n} title={p.n} right={<Text style={s.habitTitle}>{r1(p.v)} {unit}</Text>} />)}
    </Screen>
  );
}

function Nutrition() {
  const A = useApp();
  const [food, setFood] = useMeta('food', []);
  const nut = A.meta.nut || { cal: 2200, p: 140 };
  const unit = A.meta.unit || 'kg';
  const [name, setName] = useState(''), [cal, setCal] = useState(''), [p, setP] = useState('');
  const [calc, setCalc] = useState(false), [sex, setSex] = useState('m'), [age, setAge] = useState('25'), [ht, setHt] = useState('175'), [wt, setWt] = useState('70'), [act, setAct] = useState(1.55), [goal, setGoal] = useState(0);
  const today = dayKey(0);
  const todays = food.filter((f) => keyOf(f.ts) === today);
  const tc = sum(todays.map((f) => f.cal || 0)), tp = sum(todays.map((f) => f.p || 0));
  const recent = [];
  food.forEach((f) => { if (recent.length < 6 && !recent.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) recent.push(f); });
  const log = (n, c, pr) => { setFood((l) => [{ id: uid(), ts: Date.now(), name: n, cal: c, p: pr }, ...l].slice(0, 1500)); A.award('nutrition', 3); };
  const add = () => { if (!name.trim() || (num(cal) <= 0 && num(p) <= 0)) return; log(name.trim(), Math.round(num(cal)), Math.round(num(p))); setName(''); setCal(''); setP(''); };
  const kg = unit === 'lb' ? num(wt) * 0.4536 : num(wt);
  const base = tdee(sex, num(age), num(ht), kg, act), calTarget = Math.max(1200, base + goal), pTarget = Math.round(kg * (goal < 0 ? 2.0 : 1.8));
  const week = lastDays(7).slice().reverse().map((d) => ({ d, v: sum(food.filter((f) => keyOf(f.ts) === d).map((f) => f.cal || 0)) }));
  const mx = Math.max(nut.cal, ...week.map((x) => x.v), 1);
  return (
    <Screen title="Nutrition" sub="Track calories and protein against targets that fit your body and goal." onBack={undefined}>
      <View style={s.card}>
        <View style={s.between}><Text style={s.muted}>Calories</Text><Text style={s.muted}>{tc} / {nut.cal}</Text></View>
        <Bar pct={(tc / nut.cal) * 100} color={tc > nut.cal * 1.1 ? '#F87171' : C.accent} />
        <View style={s.between}><Text style={s.muted}>Protein</Text><Text style={s.muted}>{tp} / {nut.p} g</Text></View>
        <Bar pct={(tp / nut.p) * 100} color={C.online} />
        <Text style={[s.muted, { fontSize: 12 }]}>{Math.max(0, nut.cal - tc)} kcal and {Math.max(0, nut.p - tp)} g protein left today.</Text>
      </View>
      {recent.length > 0 && <Label>Log again with one tap</Label>}
      <View style={s.chipRow}>{recent.map((f) => <Pressable key={f.id} onPress={() => log(f.name, f.cal, f.p)} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>{f.name} · {f.cal}</Text></Pressable>)}</View>
      <Inp value={name} onChange={setName} ph="Food (e.g. Chicken and rice)" />
      <View style={{ flexDirection: 'row' }}>
        <Inp value={cal} onChange={setCal} num ph="Calories" style={{ flex: 1, marginRight: 8 }} />
        <Inp value={p} onChange={setP} num ph="Protein (g)" style={{ flex: 1 }} onSubmit={add} />
      </View>
      <Btn label="Log food" icon="add" onPress={add} disabled={!name.trim()} />
      {todays.map((f) => <Row key={f.id} title={f.name} sub={`${f.cal || 0} kcal · ${f.p || 0} g protein · ${timeOf(f.ts)}`} onDelete={() => setFood((l) => l.filter((x) => x.id !== f.id))} />)}
      <Text style={s.section}>Calories, last 7 days</Text>
      <View style={s.card}>
        <View style={s.bars}>{week.map((x) => <View key={x.d} style={s.barCol}><View style={[s.bar, { height: 4 + (x.v / mx) * 70, backgroundColor: x.d === today ? C.accent : '#3A3A3F' }]} /><Text style={s.barLbl}>{'SMTWTFS'[dateFrom(x.d).getDay()]}</Text></View>)}</View>
      </View>
      <Btn label={calc ? 'Hide target calculator' : 'Calorie and protein target calculator'} kind="ghost" icon="calculator-outline" onPress={() => setCalc(!calc)} />
      {calc && (
        <View style={[s.card, { marginTop: 8 }]}>
          <Label style={{ marginTop: 0 }}>Sex</Label><Chips opts={['m', 'f']} value={sex} onChange={setSex} show={(v) => (v === 'm' ? 'Male' : 'Female')} />
          <Label>Weight unit</Label><UnitChips />
          <View style={{ flexDirection: 'row' }}>
            <View style={{ flex: 1, marginRight: 8 }}><Label>Age</Label><Inp value={age} onChange={setAge} num ph="Age" /></View>
            <View style={{ flex: 1, marginRight: 8 }}><Label>Height (cm)</Label><Inp value={ht} onChange={setHt} num ph="cm" /></View>
            <View style={{ flex: 1 }}><Label>Weight ({unit})</Label><Inp value={wt} onChange={setWt} num ph={unit} /></View>
          </View>
          <Label>Activity</Label>
          <Chips opts={[1.2, 1.375, 1.55, 1.725]} value={act} onChange={setAct} show={(v) => ({ 1.2: 'Desk job', 1.375: 'Light', 1.55: 'Moderate', 1.725: 'Very active' }[v])} />
          <Label>Goal</Label>
          <Chips opts={[-500, 0, 300]} value={goal} onChange={setGoal} show={(v) => (v < 0 ? 'Lose fat' : v > 0 ? 'Build muscle' : 'Maintain')} />
          <Text style={[s.bubbleText, { marginTop: 10 }]}>Maintenance about {base} kcal. Suggested target: {calTarget} kcal and {pTarget} g protein.</Text>
          <Text style={[s.muted, { fontSize: 12 }]}>Estimates (Mifflin-St Jeor). Adjust to how your body responds over 2 to 3 weeks.</Text>
          <Btn label="Use these as my targets" onPress={() => { A.setMeta((m) => ({ ...m, nut: { cal: calTarget, p: pTarget } })); A.toast('Targets updated'); }} />
        </View>
      )}
    </Screen>
  );
}

function BodyMetrics() {
  const A = useApp();
  const [body, setBody] = useMeta('body', {});
  const unit = A.meta.unit || 'kg';
  const [w, setW] = useState(''), [wa, setWa] = useState('');
  const keys = Object.keys(body).sort();
  const latest = keys.length ? body[keys[keys.length - 1]] : null;
  const recent = keys.filter((k) => k >= dayKey(-7)).map((k) => body[k].w).filter((v) => v > 0);
  const avg7 = recent.length ? sum(recent) / recent.length : null;
  const old = keys.filter((k) => k <= dayKey(-14) && body[k].w > 0).pop();
  const change = latest && latest.w > 0 && old ? r1(latest.w - body[old].w) : null;
  const pts = keys.filter((k) => body[k].w > 0).slice(-14);
  const lo = Math.min(...pts.map((k) => body[k].w)), hi = Math.max(...pts.map((k) => body[k].w));
  const save = () => {
    if (num(w) <= 0 && num(wa) <= 0) return;
    setBody((b) => ({ ...b, [dayKey(0)]: { w: num(w) || (b[dayKey(0)] || {}).w || 0, waist: num(wa) || (b[dayKey(0)] || {}).waist || 0 } }));
    A.award('body', 3); setW(''); setWa('');
  };
  return (
    <Screen title="Body metrics" sub="Weigh in a few times a week. The 7-day average smooths out daily noise." onBack={undefined}>
      <UnitChips />
      <View style={s.tiles}>
        <Tile label="Latest" value={latest && latest.w ? `${latest.w}` : '\u2013'} sub={unit} />
        <Tile label="7-day avg" value={avg7 ? `${r1(avg7)}` : '\u2013'} sub={unit} />
        <Tile label="vs 2 weeks" value={change === null ? '\u2013' : `${change > 0 ? '+' : ''}${change}`} sub={unit} />
      </View>
      <View style={{ flexDirection: 'row' }}>
        <Inp value={w} onChange={setW} num ph={`Weight (${unit})`} style={{ flex: 1, marginRight: 8 }} />
        <Inp value={wa} onChange={setWa} num ph="Waist (optional)" style={{ flex: 1 }} onSubmit={save} />
      </View>
      <Btn label="Save today's weigh-in" icon="checkmark" onPress={save} />
      {pts.length > 1 && (
        <View style={[s.card, { marginTop: 12 }]}>
          <Text style={s.muted}>Trend (last {pts.length} weigh-ins)</Text>
          <View style={s.bars}>{pts.map((k) => <View key={k} style={s.barCol}><View style={[s.bar, { width: 10, height: 8 + (hi === lo ? 30 : ((body[k].w - lo) / (hi - lo)) * 60), backgroundColor: k === dayKey(0) ? C.accent : '#3A3A3F' }]} /></View>)}</View>
          <View style={s.between}><Text style={s.barLbl}>{lo}</Text><Text style={s.barLbl}>{hi}</Text></View>
        </View>
      )}
      <Text style={s.section}>History</Text>
      {keys.length === 0 && <Text style={s.empty}>No weigh-ins yet.</Text>}
      {keys.slice().reverse().slice(0, 10).map((k) => <Row key={k} title={`${dLabel(k)} · ${body[k].w || '\u2013'} ${unit}`} sub={body[k].waist ? `Waist ${body[k].waist}` : undefined} onDelete={() => setBody((b) => { const c = { ...b }; delete c[k]; return c; })} />)}
    </Screen>
  );
}

function Fasting() {
  const A = useApp();
  const f = A.meta.fast || { start: null, goal: 16 }, [log, setLog] = useMeta('fastLog', []);
  const el = f.start ? (Date.now() - f.start) / 36e5 : 0;
  const setGoal = (g) => A.setMeta((m) => ({ ...m, fast: { ...(m.fast || {}), goal: g, start: (m.fast || {}).start || null } }));
  const start = () => A.setMeta((m) => ({ ...m, fast: { goal: f.goal, start: Date.now() } }));
  const end = () => {
    const hrs = r1(el);
    setLog((l) => [{ id: uid(), start: f.start, end: Date.now(), hrs, goal: f.goal }, ...l].slice(0, 120));
    A.setMeta((m) => ({ ...m, fast: { goal: f.goal, start: null } }));
    if (hrs >= f.goal) { A.award('fast', 6); A.toast(`Fast complete: ${hrs}h`); } else A.toast(`Ended after ${hrs}h`);
  };
  const week = log.filter((x) => x.end >= Date.now() - 7 * 864e5);
  const met = week.filter((x) => x.hrs >= x.goal).length;
  return (
    <Screen title="Fasting" sub="Time-restricted eating, timed. Pick a window you can keep." onBack={undefined}>
      <Chips opts={[12, 14, 16, 18, 20, 24]} value={f.goal} onChange={setGoal} show={(v) => `${v}h`} />
      <View style={s.card}>
        {f.start ? (
          <>
            <Text style={s.muted}>Fasting since {timeOf(f.start)}</Text>
            <Text style={s.velocity}>{hm(el)}</Text>
            <Bar pct={(el / f.goal) * 100} color={el >= f.goal ? C.online : C.accent} />
            <Text style={s.muted}>{el >= f.goal ? 'Goal reached. End the fast when you are ready.' : `${hm(f.goal - el)} to your ${f.goal}h goal`}</Text>
            <Btn label="End fast" onPress={end} />
          </>
        ) : (
          <>
            <Text style={[s.habitTitle, { flex: 0 }]}>Ready to start a {f.goal}h fast?</Text>
            <Btn label="Start fasting timer" icon="hourglass-outline" onPress={start} />
          </>
        )}
      </View>
      <Text style={[s.muted, { fontSize: 12 }]}>Not medical advice. Skip fasting if you are under 18, pregnant, have diabetes, take medication that needs food, or have a history of disordered eating. Stop if you feel unwell.</Text>
      <Text style={s.section}>Last 7 days: {met} of {week.length} goals met</Text>
      {log.length === 0 && <Text style={s.empty}>No completed fasts yet.</Text>}
      {log.slice(0, 10).map((x) => <Row key={x.id} title={`${x.hrs}h of ${x.goal}h`} sub={dLabel(keyOf(x.end))} accent={x.hrs >= x.goal ? C.online : '#FBBF24'} check done={x.hrs >= x.goal} onDelete={() => setLog((l) => l.filter((y) => y.id !== x.id))} />)}
    </Screen>
  );
}

function Calm({ mode }) {
  const A = useApp();
  const breathe = mode === 'breathe';
  const [pat, setPat] = useState('box'), [secs, setSecs] = useState(breathe ? 180 : 600), [run, setRun] = useState(false), [el, setEl] = useState(0), [msg, setMsg] = useState('');
  const t0 = useRef(0);
  const total = A.meta.calm || {};
  const logMins = (mins) => { if (mins <= 0) return; A.setMeta((m) => ({ ...m, calm: { ...(m.calm || {}), [dayKey(0)]: r1((((m.calm || {})[dayKey(0)]) || 0) + mins) } })); A.award('calm', 5); };
  useEffect(() => {
    if (!run) return undefined;
    t0.current = Date.now() - el;
    const t = setInterval(() => setEl(Date.now() - t0.current), 100);
    return () => clearInterval(t);
  }, [run]);
  useEffect(() => {
    if (run && el >= secs * 1000) {
      setRun(false); setEl(0);
      try { Vibration.vibrate([0, 400, 200, 400]); } catch (e) {}
      logMins(secs / 60); setMsg(`Done. ${secs / 60} minutes logged.`);
    }
  }, [el, run]);
  const stopEarly = () => { setRun(false); const m = Math.floor(el / 6000) / 10; setEl(0); if (m >= 1) { logMins(m); setMsg(`Ended early. ${m} minutes logged.`); } else setMsg('Ended before a minute, so nothing was logged.'); };
  const ph = BREATH[pat].ph, st = breathe ? breathAt(ph, el) : null;
  const size = 110 + (st ? st.fill : 0.5) * 110;
  const remain = Math.max(0, Math.ceil((secs * 1000 - el) / 1000));
  const streak = (() => { let n = 0, o = (total[dayKey(0)] || 0) > 0 ? 0 : -1; while ((total[dayKey(o)] || 0) > 0) { n++; o--; } return n; })();
  return (
    <Screen title={breathe ? 'Breathwork' : 'Meditation'} sub={breathe ? BREATH[pat].note : 'Sit still, eyes closed. When your mind wanders, return to the breath.'} onBack={undefined}>
      {breathe && <Chips opts={Object.keys(BREATH)} value={pat} onChange={(v) => { if (!run) setPat(v); }} show={(v) => BREATH[v].name} />}
      <Chips opts={breathe ? [60, 180, 300] : [300, 600, 900, 1200]} value={secs} onChange={(v) => { if (!run) setSecs(v); }} show={(v) => `${v / 60} min`} />
      <View style={{ alignItems: 'center', justifyContent: 'center', height: 260 }}>
        {breathe ? (
          <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: C.accent, backgroundColor: 'rgba(244,244,245,0.08)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={s.h1}>{run ? st.label : 'Ready'}</Text>
            <Text style={s.muted}>{run ? `${st.left}s` : `${secs / 60} min`}</Text>
          </View>
        ) : <Text style={s.timer}>{pad(Math.floor((run ? remain : secs) / 60))}:{pad((run ? remain : secs) % 60)}</Text>}
      </View>
      {run ? <><Text style={[s.muted, { textAlign: 'center' }]}>{pad(Math.floor(remain / 60))}:{pad(remain % 60)} left</Text><Btn label="End early" kind="ghost" onPress={stopEarly} /></>
        : <Btn label="Start" icon="play" onPress={() => { setMsg(''); setEl(0); setRun(true); }} />}
      {!!msg && <Text style={[s.empty, { color: C.online }]}>{msg}</Text>}
      <View style={s.tiles}>
        <Tile label="Today" value={`${r1(total[dayKey(0)] || 0)}`} sub="minutes" />
        <Tile label="Last 7 days" value={`${r1(sum(lastDays(7).map((d) => total[d] || 0)))}`} sub="minutes" />
        <Tile label="Streak" value={`${streak}`} sub="days" />
      </View>
    </Screen>
  );
}
const BreatheScreen = () => <Calm mode="breathe" />;
const MeditateScreen = () => <Calm mode="meditate" />;

/* ---------- Brain: games, reading, notes, decisions, models, principles ---------- */
function MathSprint() {
  const A = useApp();
  const g = A.meta.games || {}, hist = g.math || [];
  const [phase, setPhase] = useState('idle'), [score, setScore] = useState(0), [skips, setSkips] = useState(0), [q, setQ] = useState(mathQ(0)), [val, setVal] = useState(''), [left, setLeft] = useState(60);
  const inputRef = useRef(null);
  const lvl = Math.min(4, Math.floor(score / 6));
  useEffect(() => {
    if (phase !== 'run') return undefined;
    const t = setInterval(() => setLeft((x) => x - 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    if (phase === 'run' && left <= 0) {
      setPhase('done');
      A.setMeta((m) => ({ ...m, games: { ...(m.games || {}), math: [...((m.games || {}).math || []), score].slice(-20) } }));
      A.award('brain', 4);
    }
  }, [left, phase]);
  const start = () => { setScore(0); setSkips(0); setLeft(60); setVal(''); setQ(mathQ(0)); setPhase('run'); setTimeout(() => inputRef.current && inputRef.current.focus(), 200); };
  const change = (t) => {
    setVal(t);
    if (t !== '' && Number(t) === q.ans) { const n = score + 1; setScore(n); setVal(''); setQ(mathQ(Math.min(4, Math.floor(n / 6)))); }
  };
  const best = Math.max(0, ...hist);
  return (
    <Screen title="Math sprint" sub="Mental arithmetic for 60 seconds. It gets harder as you go. Type the answer, no Enter needed." onBack={undefined}>
      <View style={s.tiles}>
        <Tile label="Best" value={`${best}`} sub="solved" />
        <Tile label="Last" value={hist.length ? `${hist[hist.length - 1]}` : '\u2013'} sub="solved" />
        <Tile label="Runs" value={`${hist.length}`} sub="total" />
      </View>
      {phase === 'run' ? (
        <View style={s.card}>
          <View style={s.between}><Text style={s.muted}>Time {left}s</Text><Text style={s.muted}>Score {score} · Level {lvl + 1}</Text></View>
          <Text style={[s.timer, { fontSize: 56, marginVertical: 18 }]}>{q.text}</Text>
          <TextInput ref={inputRef} style={[s.addInput, { flex: 0, textAlign: 'center', fontSize: 28 }]} value={val} onChangeText={change} keyboardType="number-pad" placeholder="?" placeholderTextColor={C.muted} keyboardAppearance="dark" autoFocus />
          <Btn label="Skip" kind="ghost" onPress={() => { setSkips(skips + 1); setVal(''); setQ(mathQ(lvl)); }} />
        </View>
      ) : (
        <>
          {phase === 'done' && <View style={s.card}><Text style={s.h1}>{score} solved</Text><Text style={s.muted}>{score >= best && score > 0 ? 'New personal best.' : `Your best is ${best}.`} Skipped {skips}.</Text></View>}
          <Btn label={phase === 'done' ? 'Run it again' : 'Start 60-second sprint'} icon="play" onPress={start} />
        </>
      )}
    </Screen>
  );
}

function Stroop() {
  const A = useApp();
  const g = A.meta.games || {}, best = g.stroop || 0;
  const [phase, setPhase] = useState('idle'), [ok, setOk] = useState(0), [bad, setBad] = useState(0), [q, setQ] = useState(stroopQ()), [left, setLeft] = useState(45);
  useEffect(() => {
    if (phase !== 'run') return undefined;
    const t = setInterval(() => setLeft((x) => x - 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    if (phase === 'run' && left <= 0) {
      setPhase('done');
      const sc = Math.max(0, ok - bad);
      A.setMeta((m) => ({ ...m, games: { ...(m.games || {}), stroop: Math.max((m.games || {}).stroop || 0, sc) } }));
      A.award('brain', 4);
    }
  }, [left, phase]);
  const tap = (i) => { if (i === q.ink) setOk(ok + 1); else setBad(bad + 1); setQ(stroopQ()); };
  const acc = ok + bad ? Math.round((100 * ok) / (ok + bad)) : 0;
  return (
    <Screen title="Stroop drill" sub="Tap the color the word is printed in, not the word it spells. Trains attention control and impulse inhibition." onBack={undefined}>
      <View style={s.tiles}><Tile label="Best score" value={`${best}`} sub="correct minus errors" /></View>
      {phase === 'run' ? (
        <View style={s.card}>
          <View style={s.between}><Text style={s.muted}>Time {left}s</Text><Text style={s.muted}>{ok} right · {bad} wrong</Text></View>
          <Text style={[s.timer, { fontSize: 64, color: STROOP[q.ink][1], marginVertical: 22 }]}>{q.word}</Text>
          <View style={s.chipRow}>
            {STROOP.map(([name], i) => <Pressable key={name} onPress={() => tap(i)} style={[s.ghost, { width: '48%', margin: '1%', alignItems: 'center', paddingVertical: 16 }]}><Text style={s.ghostText}>{name}</Text></Pressable>)}
          </View>
        </View>
      ) : (
        <>
          {phase === 'done' && <View style={s.card}><Text style={s.h1}>Score {Math.max(0, ok - bad)}</Text><Text style={s.muted}>{ok} right, {bad} wrong, {acc}% accuracy.</Text></View>}
          <Btn label={phase === 'done' ? 'Go again' : 'Start 45-second drill'} icon="play" onPress={() => { setOk(0); setBad(0); setLeft(45); setQ(stroopQ()); setPhase('run'); }} />
        </>
      )}
    </Screen>
  );
}

function SpeedReader() {
  const A = useApp();
  const [text, setText] = useState(SAMPLE_TEXT), [wpm, setWpm] = useState(300), [chunk, setChunk] = useState(1), [i, setI] = useState(0), [run, setRun] = useState(false), [fin, setFin] = useState(false);
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const best = (A.meta.games || {}).wpm || 0;
  const cur = words.slice(i, i + chunk).join(' ');
  useEffect(() => {
    if (!run) return undefined;
    if (i >= words.length) {
      setRun(false); setFin(true);
      if (words.length >= 50) { A.setMeta((m) => ({ ...m, games: { ...(m.games || {}), wpm: Math.max((m.games || {}).wpm || 0, wpm) } })); A.award('speed', 4); }
      return undefined;
    }
    const t = setTimeout(() => setI((x) => x + chunk), wordDelay(cur, wpm));
    return () => clearTimeout(t);
  }, [run, i]);
  return (
    <Screen title="Speed reader" sub="Words appear one chunk at a time so your eyes stop wandering. Keep the meaning in mind, then summarize it afterwards." onBack={undefined}>
      <View style={s.tiles}><Tile label="Best pace finished" value={best ? `${best}` : '\u2013'} sub="words per minute" /></View>
      <Label style={{ marginTop: 0 }}>Speed (words per minute)</Label>
      <Chips opts={[200, 300, 400, 500, 700]} value={wpm} onChange={setWpm} />
      <Label>Words at a time</Label>
      <Chips opts={[1, 2, 3]} value={chunk} onChange={setChunk} />
      <View style={[s.card, { alignItems: 'center', minHeight: 150, justifyContent: 'center' }]}>
        <Text style={[s.h1, { fontSize: 34, textAlign: 'center' }]}>{run || i > 0 ? (i >= words.length ? 'Done' : cur) : 'Ready'}</Text>
      </View>
      <Bar pct={words.length ? (i / words.length) * 100 : 0} />
      <View style={{ flexDirection: 'row' }}>
        <Pressable onPress={() => { setFin(false); if (i >= words.length) setI(0); setRun(!run); }} style={[s.addBtn, { flex: 1, marginLeft: 0, paddingVertical: 14, alignItems: 'center' }]}><Text style={s.addBtnText}>{run ? 'Pause' : i > 0 && i < words.length ? 'Resume' : 'Start'}</Text></Pressable>
        <Pressable onPress={() => { setRun(false); setI(0); setFin(false); }} style={[s.ghost, { marginLeft: 8, justifyContent: 'center' }]}><Text style={s.ghostText}>Restart</Text></Pressable>
      </View>
      {fin && <Text style={[s.empty, { color: C.online }]}>Finished {words.length} words at {wpm} wpm. Now say the main idea out loud in one sentence.</Text>}
      <Label>Paste your own text</Label>
      <Inp value={text} onChange={(t) => { setText(t); setI(0); setRun(false); }} multi ph="Paste an article or chapter" />
    </Screen>
  );
}

function Books() {
  const A = useApp();
  const [books, setBooks] = useMeta('books', []);
  const [title, setTitle] = useState(''), [pages, setPages] = useState(''), [open, setOpen] = useState(null), [note, setNote] = useState('');
  const patch = (id, f) => setBooks((l) => l.map((b) => (b.id === id ? { ...b, ...f(b) } : b)));
  const add = () => { if (!title.trim() || num(pages) <= 0) return; setBooks((l) => [{ id: uid(), title: title.trim(), pages: Math.round(num(pages)), page: 0, log: {}, notes: [], done: false }, ...l]); setTitle(''); setPages(''); };
  const read = (b, n) => {
    const np = Math.max(0, Math.min(b.pages, b.page + n)), diff = np - b.page;
    if (!diff) return;
    patch(b.id, (x) => ({ page: np, log: { ...x.log, [dayKey(0)]: Math.max(0, (x.log[dayKey(0)] || 0) + diff) }, done: np >= x.pages }));
    if (diff > 0) A.award('read', 3);
    if (np >= b.pages && !b.done && !b.paid) { patch(b.id, () => ({ paid: true })); A.setXp((x) => x + 20); A.toast(`Finished "${b.title}". +20 XP`); }
  };
  const pace = (b) => sum(lastDays(14).map((d) => b.log[d] || 0)) / 14;
  const active = books.filter((b) => !b.done), fin = books.filter((b) => b.done);
  const card = (b) => {
    const p = pace(b), eta = p > 0 ? Math.ceil((b.pages - b.page) / p) : null;
    return (
      <View key={b.id} style={s.card}>
        <View style={s.between}>
          <Text style={[s.habitTitle, { flex: 1 }]}>{b.title}</Text>
          <Pressable onPress={() => setBooks((l) => l.filter((x) => x.id !== b.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable>
        </View>
        <Bar pct={(b.page / b.pages) * 100} color={b.done ? '#FBBF24' : C.accent} />
        <Text style={s.muted}>Page {b.page} of {b.pages}{!b.done && eta !== null ? ` · about ${eta} day${eta === 1 ? '' : 's'} left at ${r1(p)} pages/day` : ''}</Text>
        {!b.done && (
          <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 8 }]}>
            {[10, 25, 50].map((n) => <Pressable key={n} onPress={() => read(b, n)} style={[s.logBtn, { marginRight: 8 }]}><Text style={s.logText}>+{n}</Text></Pressable>)}
            <Pressable onPress={() => read(b, b.pages - b.page)} style={s.logBtn}><Text style={s.logText}>Finished</Text></Pressable>
          </View>
        )}
        <Pressable onPress={() => setOpen(open === b.id ? null : b.id)} style={{ marginTop: 10 }}><Text style={s.muted}>{open === b.id ? 'Hide' : 'Show'} takeaways ({b.notes.length})</Text></Pressable>
        {open === b.id && (
          <View style={{ marginTop: 8 }}>
            {b.notes.map((n) => <View key={n.id} style={[s.between, { marginBottom: 6 }]}><Text style={[s.bubbleText, { flex: 1, fontSize: 14 }]}>• {n.text}</Text><Pressable onPress={() => patch(b.id, (x) => ({ notes: x.notes.filter((y) => y.id !== n.id) }))} hitSlop={8}><Icon n="close" size={14} color={C.muted} /></Pressable></View>)}
            <Inp value={note} onChange={setNote} ph="One idea worth keeping" onSubmit={() => { if (note.trim()) { patch(b.id, (x) => ({ notes: [...x.notes, { id: uid(), text: note.trim() }] })); setNote(''); } }} />
          </View>
        )}
      </View>
    );
  };
  return (
    <Screen title="Reading list" sub="Readers compound. Track pages, pace and the ideas worth keeping." onBack={undefined}>
      <Inp value={title} onChange={setTitle} ph="Book title" />
      <View style={{ flexDirection: 'row' }}>
        <Inp value={pages} onChange={setPages} num ph="Total pages" style={{ flex: 1, marginRight: 8 }} onSubmit={add} />
        <Pressable onPress={add} style={[s.addBtn, { marginBottom: 8, marginLeft: 0 }, (!title.trim() || num(pages) <= 0) && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable>
      </View>
      {books.length === 0 && <Text style={s.empty}>Add the book you are reading now.</Text>}
      {active.map(card)}
      {fin.length > 0 && <Text style={s.section}>Finished ({fin.length})</Text>}
      {fin.map(card)}
    </Screen>
  );
}

const NOTE_TAGS = ['idea', 'learn', 'quote', 'lesson', 'todo', 'other'];
function Notes() {
  const A = useApp();
  const [notes, setNotes] = useMeta('notes', []);
  const [text, setText] = useState(''), [tag, setTag] = useState('idea'), [q, setQ] = useState(''), [f, setF] = useState('all');
  const add = () => { if (!text.trim()) return; setNotes((l) => [{ id: uid(), ts: Date.now(), text: text.trim(), tag, pin: false }, ...l].slice(0, 1000)); A.award('note', 2); setText(''); };
  const shown = notes.filter((n) => (f === 'all' || n.tag === f) && (!q.trim() || n.text.toLowerCase().includes(q.trim().toLowerCase()))).sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.ts - a.ts);
  return (
    <Screen title="Second brain" sub={`${notes.length} notes. Capture everything, find it in seconds.`} onBack={undefined}>
      <Inp value={text} onChange={setText} multi ph="Write an idea, lesson or quote" />
      <Chips opts={NOTE_TAGS} value={tag} onChange={setTag} />
      <Btn label="Save note" icon="add" onPress={add} disabled={!text.trim()} />
      <Text style={s.section}>Find</Text>
      <Inp value={q} onChange={setQ} ph="Search notes" />
      <Chips opts={['all', ...NOTE_TAGS]} value={f} onChange={setF} />
      {shown.length === 0 && <Text style={s.empty}>Nothing matches.</Text>}
      {shown.map((n) => (
        <View key={n.id} style={s.card}>
          <View style={s.between}>
            <Text style={s.muted}>{n.tag} · {dLabel(keyOf(n.ts))}</Text>
            <View style={s.btnRow}>
              {n.tag === 'todo' && <Pressable onPress={() => { A.addTask(n.text.slice(0, 120), 'discipline'); A.toast('Added to your tasks'); }} hitSlop={8}><Icon n="arrow-redo-outline" size={17} color={C.muted} style={{ marginRight: 12 }} /></Pressable>}
              <Pressable onPress={() => setNotes((l) => l.map((x) => (x.id === n.id ? { ...x, pin: !x.pin } : x)))} hitSlop={8}><Icon n={n.pin ? 'pin' : 'pin-outline'} size={17} color={n.pin ? '#FBBF24' : C.muted} style={{ marginRight: 12 }} /></Pressable>
              <Pressable onPress={() => setNotes((l) => l.filter((x) => x.id !== n.id))} hitSlop={8}><Icon n="close" size={17} color={C.muted} /></Pressable>
            </View>
          </View>
          <Text style={[s.bubbleText, { marginTop: 6 }]}>{n.text}</Text>
        </View>
      ))}
    </Screen>
  );
}

function Decisions() {
  const A = useApp();
  const [ds, setDs] = useMeta('decisions', []);
  const [title, setTitle] = useState(''), [why, setWhy] = useState(''), [exp, setExp] = useState(''), [conf, setConf] = useState(70), [rev, setRev] = useState(30);
  const add = () => {
    if (!title.trim()) return;
    setDs((l) => [{ id: uid(), ts: Date.now(), title: title.trim(), why: why.trim(), expect: exp.trim(), conf, review: dayKey(rev), outcome: null }, ...l]);
    A.award('decision', 4); setTitle(''); setWhy(''); setExp('');
  };
  const cal = calib(ds), pending = ds.filter((d) => !d.outcome).sort((a, b) => a.review.localeCompare(b.review)), done = ds.filter((d) => d.outcome);
  return (
    <Screen title="Decision journal" sub="Write the decision, your reasoning and your confidence now. Review it later. This is how you stop fooling yourself." onBack={undefined}>
      {cal && (
        <View style={s.tiles}>
          <Tile label="Hit rate" value={`${cal.rate}%`} sub={`${cal.n} reviewed`} />
          <Tile label="Confidence" value={`${cal.conf}%`} sub="your average" />
          <Tile label="Gap" value={`${cal.gap > 0 ? '+' : ''}${cal.gap}`} sub={cal.gap > 10 ? 'overconfident' : cal.gap < -10 ? 'underconfident' : 'well calibrated'} color={Math.abs(cal.gap) <= 10 ? C.online : '#FBBF24'} />
        </View>
      )}
      <Inp value={title} onChange={setTitle} ph="The decision (e.g. Take the new job)" />
      <Inp value={why} onChange={setWhy} multi ph="Why? Options considered, key assumptions" style={{ minHeight: 70 }} />
      <Inp value={exp} onChange={setExp} ph="What do you expect to happen?" />
      <Label style={{ marginTop: 0 }}>Confidence you are right</Label>
      <Chips opts={[50, 60, 70, 80, 90, 99]} value={conf} onChange={setConf} show={(v) => `${v}%`} />
      <Label>Review it in</Label>
      <Chips opts={[7, 14, 30, 90]} value={rev} onChange={setRev} show={(v) => `${v} days`} />
      <Btn label="Record decision" icon="add" onPress={add} disabled={!title.trim()} />
      {pending.length > 0 && <Text style={s.section}>Waiting for review</Text>}
      {pending.map((d) => {
        const dueNow = d.review <= dayKey(0);
        return (
          <View key={d.id} style={[s.card, dueNow && { borderColor: '#FBBF24' }]}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{d.title}</Text><Pressable onPress={() => setDs((l) => l.filter((x) => x.id !== d.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
            {!!d.expect && <Text style={s.muted}>Expected: {d.expect}</Text>}
            <Text style={s.muted}>{d.conf}% confident · review {dueNow ? 'now' : `on ${dLabel(d.review)}`}</Text>
            {dueNow && (
              <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 10 }]}>
                {[['right', 'Right'], ['mixed', 'Mixed'], ['wrong', 'Wrong']].map(([k, l]) => <Pressable key={k} onPress={() => { setDs((x) => x.map((y) => (y.id === d.id ? { ...y, outcome: k } : y))); A.award('decision-review', 5); }} style={[s.logBtn, { marginRight: 8 }]}><Text style={s.logText}>{l}</Text></Pressable>)}
              </View>
            )}
          </View>
        );
      })}
      {done.length > 0 && <Text style={s.section}>Reviewed</Text>}
      {done.slice(0, 15).map((d) => <Row key={d.id} title={d.title} sub={`${d.conf}% confident · it was ${d.outcome}`} accent={d.outcome === 'right' ? C.online : d.outcome === 'wrong' ? '#F87171' : '#FBBF24'} check done onDelete={() => setDs((l) => l.filter((x) => x.id !== d.id))} />)}
    </Screen>
  );
}

function DecisionMatrix() {
  const [mx, setMx] = useMeta('matrix', { title: '', crit: [], opts: [] });
  const [cn, setCn] = useState(''), [on, setOn] = useState('');
  const maxPts = sum(mx.crit.map((c) => c.w * 5)) || 1;
  const total = (o) => sum(mx.crit.map((c) => c.w * ((o.sc || {})[c.id] || 0)));
  const ranked = mx.opts.slice().sort((a, b) => total(b) - total(a));
  const upd = (f) => setMx((m) => f({ ...m }));
  return (
    <Screen title="Decision matrix" sub="Name what matters, weight it 1 to 5, then score each option 0 to 5. The math shows what you actually value." onBack={undefined}>
      <Inp value={mx.title} onChange={(t) => upd((m) => ({ ...m, title: t }))} ph="What are you deciding?" />
      <Text style={s.section}>Criteria</Text>
      <View style={s.addRow}><TextInput style={s.addInput} value={cn} onChangeText={setCn} placeholder="e.g. Salary, Growth, Stress" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={() => { if (cn.trim()) { upd((m) => ({ ...m, crit: [...m.crit, { id: uid(), name: cn.trim(), w: 3 }] })); setCn(''); } }} />
        <Pressable onPress={() => { if (cn.trim()) { upd((m) => ({ ...m, crit: [...m.crit, { id: uid(), name: cn.trim(), w: 3 }] })); setCn(''); } }} style={[s.addBtn, !cn.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {mx.crit.map((c) => (
        <View key={c.id} style={s.item}>
          <Text style={s.itemText}>{c.name}</Text>
          <Text style={[s.muted, { marginRight: 8 }]}>weight</Text>
          {[1, 2, 3, 4, 5].map((w) => <Pressable key={w} onPress={() => upd((m) => ({ ...m, crit: m.crit.map((x) => (x.id === c.id ? { ...x, w } : x)) }))} style={[s.mini, { width: 30, marginRight: 4 }, c.w === w && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{w}</Text></Pressable>)}
          <Pressable onPress={() => upd((m) => ({ ...m, crit: m.crit.filter((x) => x.id !== c.id) }))} hitSlop={8}><Icon n="close" size={16} color={C.muted} style={{ marginLeft: 6 }} /></Pressable>
        </View>
      ))}
      <Text style={s.section}>Options</Text>
      <View style={s.addRow}><TextInput style={s.addInput} value={on} onChangeText={setOn} placeholder="e.g. Job A, Job B" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={() => { if (on.trim()) { upd((m) => ({ ...m, opts: [...m.opts, { id: uid(), name: on.trim(), sc: {} }] })); setOn(''); } }} />
        <Pressable onPress={() => { if (on.trim()) { upd((m) => ({ ...m, opts: [...m.opts, { id: uid(), name: on.trim(), sc: {} }] })); setOn(''); } }} style={[s.addBtn, !on.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {mx.opts.map((o) => (
        <View key={o.id} style={s.card}>
          <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{o.name}</Text><Pressable onPress={() => upd((m) => ({ ...m, opts: m.opts.filter((x) => x.id !== o.id) }))} hitSlop={8}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
          {mx.crit.map((c) => (
            <View key={c.id} style={[s.between, { marginTop: 8 }]}>
              <Text style={[s.muted, { flex: 1 }]}>{c.name} (×{c.w})</Text>
              <View style={s.btnRow}>{[0, 1, 2, 3, 4, 5].map((v) => <Pressable key={v} onPress={() => upd((m) => ({ ...m, opts: m.opts.map((x) => (x.id === o.id ? { ...x, sc: { ...x.sc, [c.id]: v } } : x)) }))} style={[s.mini, { width: 28, marginRight: 3, paddingVertical: 4 }, (o.sc || {})[c.id] === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{v}</Text></Pressable>)}</View>
            </View>
          ))}
        </View>
      ))}
      {ranked.length > 0 && mx.crit.length > 0 && (
        <>
          <Text style={s.section}>Ranking</Text>
          <View style={s.card}>
            {ranked.map((o, i) => (
              <View key={o.id} style={{ marginBottom: 6 }}>
                <View style={s.between}><Text style={[s.habitTitle, { flex: 0 }]}>{i === 0 ? 'Best: ' : ''}{o.name}</Text><Text style={s.muted}>{total(o)} / {maxPts}</Text></View>
                <Bar pct={(total(o) / maxPts) * 100} color={i === 0 ? C.online : C.muted} />
              </View>
            ))}
            <Text style={[s.muted, { fontSize: 12 }]}>If the winner feels wrong, a criterion is missing or mis-weighted. That is useful information too.</Text>
          </View>
        </>
      )}
      <Btn label="Clear matrix" kind="ghost" onPress={() => setMx({ title: '', crit: [], opts: [] })} />
    </Screen>
  );
}

function PreMortem() {
  const A = useApp();
  const [list, setList] = useMeta('premortems', []);
  const [proj, setProj] = useState(''), [fail, setFail] = useState(''), [fix, setFix] = useState('');
  const add = () => { if (!proj.trim() || !fail.trim()) return; setList((l) => [{ id: uid(), ts: Date.now(), proj: proj.trim(), fail: fail.trim(), fix: fix.trim() }, ...l]); A.award('premortem', 4); setProj(''); setFail(''); setFix(''); };
  return (
    <Screen title="Pre-mortem" sub="Assume it already failed. Working backwards from failure finds risks that optimism hides." onBack={undefined}>
      <Inp value={proj} onChange={setProj} ph="Project or plan" />
      <Inp value={fail} onChange={setFail} multi ph="It is 6 months from now and this failed. What went wrong? List every reason." />
      <Inp value={fix} onChange={setFix} multi ph="What will you do now to prevent each one?" />
      <Btn label="Save pre-mortem" icon="add" onPress={add} disabled={!proj.trim() || !fail.trim()} />
      {list.map((p) => (
        <View key={p.id} style={[s.card, { marginTop: 12 }]}>
          <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{p.proj}</Text><Pressable onPress={() => setList((l) => l.filter((x) => x.id !== p.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
          <Label>Why it failed</Label><Text style={s.bubbleText}>{p.fail}</Text>
          {!!p.fix && <><Label>Prevention</Label><Text style={s.bubbleText}>{p.fix}</Text></>}
          <Btn label="Red-team it with Coach" kind="ghost" icon="sparkles-outline" disabled={!A.online} onPress={() => A.analyze(`Red-team my plan "${p.proj}". I think it could fail because: ${p.fail}. My prevention ideas: ${p.fix || 'none yet'}. Find what I missed, rank the risks, and give me the 3 best mitigations.`)} />
        </View>
      ))}
    </Screen>
  );
}

function Models() {
  const A = useApp();
  const [applied, setApplied] = useMeta('mmApplied', {});
  const [open, setOpen] = useState(null);
  const daily = MODELS[dayOfYear() % MODELS.length];
  const used = Object.keys(applied).length;
  return (
    <Screen title="Mental models" sub={`A new model each day. You have applied ${used} of ${MODELS.length}.`} onBack={undefined}>
      <View style={[s.card, { borderColor: C.accent }]}>
        <Text style={s.muted}>Model of the day</Text>
        <Text style={[s.h1, { marginTop: 4 }]}>{daily.name}</Text>
        <Text style={[s.bubbleText, { marginTop: 8 }]}>{daily.tip}</Text>
        <Text style={[s.bigQ, { fontSize: 18, lineHeight: 24 }]}>{daily.ask}</Text>
        <Btn label={`I applied this today${applied[daily.id] ? ` (${applied[daily.id]}×)` : ''}`} icon="checkmark" onPress={() => { setApplied((a) => ({ ...a, [daily.id]: (a[daily.id] || 0) + 1 })); A.award('model', 4); }} />
      </View>
      <Text style={s.section}>Library</Text>
      {MODELS.map((m) => (
        <Pressable key={m.id} onPress={() => setOpen(open === m.id ? null : m.id)} style={[s.item, { flexDirection: 'column', alignItems: 'flex-start' }]}>
          <View style={[s.between, { width: '100%' }]}><Text style={[s.itemText, { flex: 0 }]}>{m.name}</Text><Text style={s.muted}>{applied[m.id] ? `used ${applied[m.id]}×` : ''}</Text></View>
          {open === m.id && <><Text style={[s.muted, { marginTop: 6 }]}>{m.tip}</Text><Text style={[s.bubbleText, { marginTop: 6 }]}>Ask: {m.ask}</Text></>}
        </Pressable>
      ))}
    </Screen>
  );
}

const RULE_IDEAS = ['Do the hardest thing first', 'Decide once, then stop re-deciding', 'No phone for the first hour of the day'];
const IDENTITY_IDEAS = ['I keep promises to myself', 'I am someone who trains no matter what', 'I learn something every day'];
function Principles() {
  const [pr, setPr] = useMeta('principles', { rules: [], identity: [] });
  const [rule, setRule] = useState(''), [idt, setIdt] = useState('');
  const rules = pr.rules || [], identity = pr.identity || [];
  const addTo = (k, text, clear) => { if (!text.trim()) return; setPr((p) => ({ ...p, [k]: [...(p[k] || []), { id: uid(), text: text.trim() }] })); clear(''); };
  const del = (k, id) => setPr((p) => ({ ...p, [k]: (p[k] || []).filter((x) => x.id !== id) }));
  return (
    <Screen title="Principles" sub="Rules you decide in advance, and the person you are becoming. One shows on Today every day and your Coach uses them." onBack={undefined}>
      <Text style={s.section}>My rules</Text>
      <View style={s.addRow}><TextInput style={s.addInput} value={rule} onChangeText={setRule} placeholder="A rule you live by" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={() => addTo('rules', rule, setRule)} /><Pressable onPress={() => addTo('rules', rule, setRule)} style={[s.addBtn, !rule.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {rules.length === 0 && <View style={s.chipRow}>{RULE_IDEAS.map((x) => <Pressable key={x} onPress={() => addTo('rules', x, () => {})} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>+ {x}</Text></Pressable>)}</View>}
      {rules.map((x) => <Row key={x.id} title={x.text} onDelete={() => del('rules', x.id)} />)}
      <Text style={s.section}>Who I am becoming</Text>
      <View style={s.addRow}><TextInput style={s.addInput} value={idt} onChangeText={setIdt} placeholder="I am someone who..." placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={() => addTo('identity', idt, setIdt)} /><Pressable onPress={() => addTo('identity', idt, setIdt)} style={[s.addBtn, !idt.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {identity.length === 0 && <View style={s.chipRow}>{IDENTITY_IDEAS.map((x) => <Pressable key={x} onPress={() => addTo('identity', x, () => {})} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>+ {x}</Text></Pressable>)}</View>}
      {identity.map((x) => <Row key={x.id} title={x.text} onDelete={() => del('identity', x.id)} />)}
    </Screen>
  );
}

function Wins() {
  const A = useApp();
  const [wins, setWins] = useMeta('winsV', []);
  const [text, setText] = useState(''), [proof, setProof] = useState(null);
  const add = () => { if (!text.trim()) return; setWins((l) => [{ id: uid(), ts: Date.now(), text: text.trim() }, ...l].slice(0, 500)); A.award('win', 2); setText(''); };
  return (
    <Screen title="Wins vault" sub="Your brain remembers failures more than wins. Keep the evidence, and pull it out when doubt shows up." onBack={undefined}>
      <Inp value={text} onChange={setText} ph="A win, big or small" onSubmit={add} />
      <Btn label="Add to vault" icon="add" onPress={add} disabled={!text.trim()} />
      <Btn label="Show me proof I can do hard things" kind="ghost" icon="medal-outline" disabled={wins.length === 0} onPress={() => setProof(wins[Math.floor(Math.random() * wins.length)])} />
      {proof && <View style={[s.card, { marginTop: 12, borderColor: '#FBBF24' }]}><Text style={s.muted}>{dLabel(keyOf(proof.ts))}</Text><Text style={[s.bigQ, { fontSize: 20, lineHeight: 26 }]}>{proof.text}</Text></View>}
      <Text style={s.section}>{wins.length} wins</Text>
      {wins.slice(0, 40).map((w) => <Row key={w.id} title={w.text} sub={dLabel(keyOf(w.ts))} onDelete={() => setWins((l) => l.filter((x) => x.id !== w.id))} />)}
    </Screen>
  );
}

/* ---------- Execute: priorities, rituals, time, energy, projects ---------- */
function PriorityMatrix() {
  const A = useApp();
  const open = A.tasks.filter((t) => !t.done);
  const quad = (u, i) => open.filter((t) => !!t.urgent === u && !!t.imp === i);
  const Q = [
    { k: 'do', name: 'Do first', sub: 'Urgent and important', color: '#F87171', list: quad(true, true) },
    { k: 'plan', name: 'Schedule', sub: 'Important, not urgent. Where results come from', color: C.online, list: quad(false, true) },
    { k: 'del', name: 'Delegate or batch', sub: 'Urgent, not important', color: '#FBBF24', list: quad(true, false) },
    { k: 'drop', name: 'Drop or defer', sub: 'Neither. Delete without guilt', color: C.muted, list: quad(false, false) },
  ];
  return (
    <Screen title="Priority matrix" sub="Flag each open task as urgent and/or important. Most people live in urgent. Leverage lives in important." onBack={undefined}>
      {open.length === 0 && <Text style={s.empty}>No open tasks. Add some on Today.</Text>}
      {Q.map((q) => (
        <View key={q.k} style={[s.card, { borderColor: q.color }]}>
          <View style={s.between}><Text style={[s.habitTitle, { flex: 0, color: q.color }]}>{q.name} ({q.list.length})</Text></View>
          <Text style={[s.muted, { fontSize: 12, marginBottom: 6 }]}>{q.sub}</Text>
          {q.list.map((t) => (
            <View key={t.id} style={{ marginTop: 8 }}>
              <Text style={s.bubbleText}>{t.title}</Text>
              <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 6 }]}>
                <Pressable onPress={() => A.flagTask(t.id, 'urgent')} style={[s.logBtn, { paddingVertical: 4, marginRight: 8 }, t.urgent && { borderColor: '#F87171' }]}><Text style={s.logText}>Urgent</Text></Pressable>
                <Pressable onPress={() => A.flagTask(t.id, 'imp')} style={[s.logBtn, { paddingVertical: 4, marginRight: 8 }, t.imp && { borderColor: C.online }]}><Text style={s.logText}>Important</Text></Pressable>
                {q.k === 'do' && !t.star && <Pressable onPress={() => A.starTask(t.id)} style={[s.logBtn, { paddingVertical: 4, marginRight: 8 }]}><Text style={s.logText}>Star it</Text></Pressable>}
                {q.k === 'drop' && <Pressable onPress={() => A.deleteTask(t.id)} style={[s.logBtn, { paddingVertical: 4 }]}><Text style={s.logText}>Delete</Text></Pressable>}
              </View>
            </View>
          ))}
        </View>
      ))}
    </Screen>
  );
}

function Shutdown() {
  const A = useApp();
  const t = dayKey(0), done = (A.meta.shutdown || {})[t];
  const open = A.tasks.filter((x) => !x.done);
  const [ids, setIds] = useState(() => (A.meta.ivy && A.meta.ivy.ids ? A.meta.ivy.ids.filter((id) => open.some((x) => x.id === id)) : []));
  const [grat, setGrat] = useState(''), [one, setOne] = useState((A.meta.ivy && A.meta.ivy.one) || '');
  const wins = A.activity[t] || 0, fm = (A.meta.focusDays || {})[t] || 0, doneT = A.tasks.filter((x) => x.done && x.doneOn === t).length;
  const pl = A.plan, pd = pl ? pl.blocks.filter((b) => b.done).length : 0;
  const toggle = (id) => setIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : l.length >= 6 ? l : [...l, id]));
  return (
    <Screen title="Evening shutdown" sub="Close the loops, then set tomorrow up tonight. Your brain stops rehearsing the day, and you wake up with a plan." onBack={undefined}>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>1. Today in numbers</Text>
        <Text style={[s.muted, { marginTop: 6 }]}>{wins} wins · {doneT} tasks finished · {fm} focus minutes{pl ? ` · ${pd}/${pl.blocks.length} plan blocks` : ''}</Text>
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>2. One thing that went well</Text>
        <Inp value={grat} onChange={setGrat} ph="Gratitude or a small win" style={{ marginTop: 8, marginBottom: 0 }} />
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>3. Tomorrow's top {ids.length}/6 (Ivy Lee list)</Text>
        <Text style={[s.muted, { marginBottom: 6 }]}>Tap tasks in the order you will do them. Finish #1 before touching #2.</Text>
        {open.length === 0 && <Text style={s.muted}>No open tasks. Add some on Today first.</Text>}
        {open.map((x) => { const n = ids.indexOf(x.id); return <Pressable key={x.id} onPress={() => toggle(x.id)} style={[s.planRow, n >= 0 && { borderColor: C.accent }]}><View style={[s.check, { borderColor: C.accent }, n >= 0 && { backgroundColor: C.accent }]}>{n >= 0 && <Text style={{ color: C.onAccent, fontWeight: '800', fontSize: 13 }}>{n + 1}</Text>}</View><Text style={[s.itemText, { flex: 1 }]}>{x.title}</Text></Pressable>; })}
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>4. The one thing for tomorrow</Text>
        <Inp value={one} onChange={setOne} ph="If I only do one thing, it is..." style={{ marginTop: 8, marginBottom: 0 }} />
      </View>
      {done ? <Text style={[s.empty, { color: C.online }]}>Shutdown complete for today. Rest well.</Text> : null}
      <Btn label={done ? 'Update tomorrow' : 'Complete shutdown'} icon="power-outline" onPress={() => A.finishShutdown({ grat: grat.trim(), ids, one: one.trim() })} />
    </Screen>
  );
}

function TimeTracker() {
  const A = useApp();
  const [log, setLog] = useMeta('timeLog', []);
  const tm = A.meta.timer;
  const [label, setLabel] = useState(''), [cat, setCat] = useState('career');
  const today = dayKey(0), tl = log.filter((x) => keyOf(x.end) === today);
  const recent = [...new Set(log.map((x) => x.label))].slice(0, 6);
  const start = () => { if (!label.trim()) return; A.setMeta((m) => ({ ...m, timer: { start: Date.now(), label: label.trim(), cat } })); setLabel(''); };
  const stop = () => {
    const mins = r1((Date.now() - tm.start) / 60000);
    A.setMeta((m) => ({ ...m, timer: null }));
    if (mins < 0.5) { A.toast('Under 30 seconds, so it was discarded'); return; }
    setLog((l) => [{ id: uid(), start: tm.start, end: Date.now(), mins, label: tm.label, cat: tm.cat }, ...l].slice(0, 500));
  };
  const byCat = (days) => CATS.map((c) => ({ c, v: sum(log.filter((x) => days.includes(keyOf(x.end)) && x.cat === c.id).map((x) => x.mins)) }));
  const t7 = byCat(lastDays(7)), mx = Math.max(1, ...t7.map((x) => x.v)), top = t7.slice().sort((a, b) => b.v - a.v)[0];
  return (
    <Screen title="Time tracker" sub="You cannot manage what you do not measure. Track a week and the truth about your time shows up." onBack={undefined}>
      {tm ? (
        <View style={[s.card, { borderColor: C.accent }]}>
          <Text style={s.muted}>Tracking · {catOf(tm.cat).name}</Text>
          <Text style={[s.habitTitle, { flex: 0, marginTop: 4 }]}>{tm.label}</Text>
          <Text style={s.velocity}>{hm((Date.now() - tm.start) / 36e5)}</Text>
          <Btn label="Stop and save" icon="stop" onPress={stop} />
        </View>
      ) : (
        <>
          <Inp value={label} onChange={setLabel} ph="What are you doing?" onSubmit={start} />
          {recent.length > 0 && <View style={s.chipRow}>{recent.map((r) => <Pressable key={r} onPress={() => setLabel(r)} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>{r}</Text></Pressable>)}</View>}
          <CatChips value={cat} onChange={setCat} />
          <Btn label="Start timer" icon="play" onPress={start} disabled={!label.trim()} />
        </>
      )}
      <Text style={s.section}>Where your week went</Text>
      <View style={s.card}>
        {t7.map(({ c, v }) => <View key={c.id} style={{ marginBottom: 4 }}><View style={s.between}><Text style={s.muted}>{c.name}</Text><Text style={s.muted}>{hm(v / 60)}</Text></View><Bar pct={(v / mx) * 100} color={c.color} /></View>)}
        {top && top.v > 0 && <Text style={[s.muted, { fontSize: 12 }]}>Biggest block: {top.c.name} with {hm(top.v / 60)} tracked this week.</Text>}
      </View>
      <Text style={s.section}>Today · {hm(sum(tl.map((x) => x.mins)) / 60)}</Text>
      {tl.length === 0 && <Text style={s.empty}>Nothing tracked today.</Text>}
      {tl.map((x) => <Row key={x.id} title={x.label} sub={`${catOf(x.cat).name} · ${timeOf(x.start)}`} right={<Text style={s.habitTitle}>{Math.round(x.mins)}m</Text>} onDelete={() => setLog((l) => l.filter((y) => y.id !== x.id))} />)}
    </Screen>
  );
}

function EnergyMap() {
  const A = useApp();
  const [log, setLog] = useMeta('energy', []);
  const by = energyByHour(log), best = bestEnergy(log);
  const hours = Array.from({ length: 19 }, (_, i) => i + 5);
  const labels = ['Drained', 'Low', 'OK', 'Good', 'Peak'];
  const now = new Date().getHours();
  return (
    <Screen title="Energy map" sub="Tap your energy a few times a day. After about 10 taps the app finds your real peak hours." onBack={undefined}>
      <Text style={s.muted}>How is your energy right now?</Text>
      <View style={[s.btnRow, { marginVertical: 10 }]}>
        {[1, 2, 3, 4, 5].map((v) => <Pressable key={v} onPress={() => { setLog((l) => [{ ts: Date.now(), v }, ...l].slice(0, 400)); A.award('energy', 2); }} style={[s.ghost, { flex: 1, marginRight: v < 5 ? 6 : 0, alignItems: 'center', paddingHorizontal: 4 }]}><Text style={s.ghostText}>{v}</Text><Text style={[s.barLbl, { fontSize: 10 }]}>{labels[v - 1]}</Text></Pressable>)}
      </View>
      <View style={s.card}>
        <Text style={s.muted}>Average energy by hour</Text>
        <View style={s.bars}>
          {hours.map((h) => <View key={h} style={s.barCol}><View style={[s.bar, { width: 9, height: by[h] ? 6 + (by[h] / 5) * 70 : 3, backgroundColor: best && h >= best.start && h < best.end ? C.online : h === now ? C.accent : '#3A3A3F' }]} />{h % 3 === 2 ? <Text style={[s.barLbl, { fontSize: 9 }]}>{h % 12 || 12}</Text> : <Text style={[s.barLbl, { fontSize: 9 }]}> </Text>}</View>)}
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>{log.length} taps logged.</Text>
      </View>
      {best ? (
        <View style={s.card}>
          <Text style={[s.habitTitle, { flex: 0 }]}>Your best window: {fmt(best.start)} to {fmt(best.end)}</Text>
          <Text style={[s.muted, { marginTop: 4 }]}>Average energy {best.score} out of 5. Put your hardest work here.</Text>
          {A.meta.peakOverride && A.meta.peakOverride.start === best.start ? <Text style={[s.muted, { color: C.online, marginTop: 6 }]}>This is already your peak window.</Text> : <Btn label="Use as my peak window" icon="flash-outline" onPress={() => { A.setMeta((m) => ({ ...m, peakOverride: { start: best.start, end: best.end } })); A.toast('Peak window updated everywhere'); }} />}
          {!!A.meta.peakOverride && <Btn label="Go back to automatic peak" kind="ghost" onPress={() => A.setMeta((m) => ({ ...m, peakOverride: null }))} />}
        </View>
      ) : <Text style={s.empty}>Need {Math.max(0, 10 - log.length)} more taps to find your window.</Text>}
    </Screen>
  );
}

function AntiHabits() {
  const A = useApp();
  const [list, setList] = useMeta('anti', []);
  const [title, setTitle] = useState('');
  const t = dayKey(0);
  const add = () => { if (!title.trim()) return; setList((l) => [...l, { id: uid(), title: title.trim(), start: t, resisted: [], slips: [] }]); setTitle(''); };
  const patch = (id, f) => setList((l) => l.map((x) => (x.id === id ? { ...x, ...f(x) } : x)));
  const clean = (x) => { const last = x.slips.slice().sort().pop(); return daysBetween(last || x.start, t); };
  return (
    <Screen title="Break bad habits" sub="List what you refuse to do. Mark each day you held the line. Your clean streak resets when you slip, and that is okay." onBack={undefined}>
      <View style={s.addRow}><TextInput style={s.addInput} value={title} onChangeText={setTitle} placeholder="e.g. No social media before noon" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={add} /><Pressable onPress={add} style={[s.addBtn, !title.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {list.length === 0 && <Text style={s.empty}>What is one thing you want to stop?</Text>}
      {list.map((x) => {
        const won = x.resisted.includes(t), slipped = x.slips.includes(t);
        return (
          <View key={x.id} style={s.card}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{x.title}</Text><Pressable onPress={() => setList((l) => l.filter((y) => y.id !== x.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
            <Text style={s.velocity}>{clean(x)}<Text style={s.muted}> clean days</Text></Text>
            <Text style={s.muted}>Held the line {x.resisted.length} times · slipped {x.slips.length}</Text>
            <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 10 }]}>
              <Pressable onPress={() => { if (!won) { patch(x.id, (y) => ({ resisted: [...y.resisted, t], slips: y.slips.filter((d) => d !== t) })); A.award(`anti:${x.id}`, 3); } }} style={[s.logBtn, { marginRight: 8 }, won && { borderColor: C.online }]}><Text style={s.logText}>{won ? 'Held today' : 'I held the line'}</Text></Pressable>
              <Pressable onPress={() => { if (!slipped) patch(x.id, (y) => ({ slips: [...y.slips, t], resisted: y.resisted.filter((d) => d !== t) })); }} style={[s.logBtn, slipped && { borderColor: '#F87171' }]}><Text style={s.logText}>{slipped ? 'Slipped today' : 'I slipped'}</Text></Pressable>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

function Big3() {
  const A = useApp();
  const wk = mondayKey(0), b = A.meta.big3 && A.meta.big3.wk === wk ? A.meta.big3 : { wk, items: [], paid: false };
  const [text, setText] = useState('');
  const save = (items, paid) => A.setMeta((m) => ({ ...m, big3: { wk, items, paid: paid === undefined ? b.paid : paid } }));
  const add = () => { if (!text.trim() || b.items.length >= 3) return; save([...b.items, { id: uid(), text: text.trim(), done: false }]); setText(''); };
  const toggle = (id) => {
    const items = b.items.map((x) => (x.id === id ? { ...x, done: !x.done } : x));
    const all = items.length === 3 && items.every((x) => x.done);
    if (all && !b.paid) { save(items, true); A.setXp((x) => x + 20); A.toast('All three done. +20 XP'); } else save(items);
  };
  return (
    <Screen title="Weekly Big 3" sub="Three outcomes that would make this week a success. Not a to-do list. Resets every Monday." onBack={undefined}>
      {b.items.length < 3 && <View style={s.addRow}><TextInput style={s.addInput} value={text} onChangeText={setText} placeholder={`Outcome ${b.items.length + 1} of 3`} placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={add} /><Pressable onPress={add} style={[s.addBtn, !text.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>}
      {b.items.map((x) => <Row key={x.id} title={x.text} check done={x.done} accent={C.online} onPress={() => toggle(x.id)} onDelete={() => save(b.items.filter((y) => y.id !== x.id))} />)}
      <Text style={s.muted}>{b.items.filter((x) => x.done).length} of {b.items.length || 3} done this week. Finishing all three earns 20 XP.</Text>
    </Screen>
  );
}

function Projects() {
  const A = useApp();
  const [list, setList] = useMeta('projects', []);
  const [title, setTitle] = useState(''), [cat, setCat] = useState('career'), [step, setStep] = useState({});
  const add = () => { if (!title.trim()) return; setList((l) => [{ id: uid(), title: title.trim(), cat, steps: [], touched: Date.now(), paid: false }, ...l]); setTitle(''); };
  const patch = (id, f) => setList((l) => l.map((p) => (p.id === id ? { ...p, ...f(p) } : p)));
  const toggle = (p, sid) => {
    const steps = p.steps.map((x) => (x.id === sid ? { ...x, done: !x.done } : x));
    patch(p.id, () => ({ steps, touched: Date.now() }));
    if (steps.length > 0 && steps.every((x) => x.done) && !p.paid) { patch(p.id, () => ({ paid: true })); A.setXp((x) => x + 25); A.toast(`Project done: ${p.title}. +25 XP`); }
  };
  return (
    <Screen title="Projects" sub="Every project needs a clear next action. Stalled projects get flagged after 7 quiet days." onBack={undefined}>
      <Inp value={title} onChange={setTitle} ph="Project (an outcome with several steps)" onSubmit={add} />
      <CatChips value={cat} onChange={setCat} />
      <Btn label="Add project" icon="add" onPress={add} disabled={!title.trim()} />
      {list.map((p) => {
        const done = p.steps.filter((x) => x.done).length, next = p.steps.find((x) => !x.done), stalled = next && Date.now() - p.touched > 7 * 864e5;
        return (
          <View key={p.id} style={[s.card, { marginTop: 12 }, stalled && { borderColor: '#FBBF24' }]}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{p.title}</Text><Pressable onPress={() => setList((l) => l.filter((x) => x.id !== p.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
            <Bar pct={p.steps.length ? (done / p.steps.length) * 100 : 0} color={catOf(p.cat).color} />
            <Text style={s.muted}>{done}/{p.steps.length} steps{stalled ? ' · stalled, pick the next action today' : ''}</Text>
            {next && <Text style={[s.bubbleText, { marginTop: 6 }]}>Next: {next.text}</Text>}
            {p.steps.map((x) => (
              <View key={x.id} style={[s.between, { marginTop: 8 }]}>
                <Pressable onPress={() => toggle(p, x.id)} style={[s.btnRow, { flex: 1, justifyContent: 'flex-start' }]}>
                  <View style={[s.check, { width: 22, height: 22, borderRadius: 11, borderColor: catOf(p.cat).color, marginRight: 10 }, x.done && { backgroundColor: catOf(p.cat).color }]}>{x.done && <Icon n="checkmark" size={13} color="#000" />}</View>
                  <Text style={[s.bubbleText, { flex: 1, fontSize: 15 }, x.done && s.done]}>{x.text}</Text>
                </Pressable>
                {!x.done && <Pressable onPress={() => { A.addTask(x.text, p.cat); A.toast('Sent to Today'); }} hitSlop={8}><Icon n="arrow-redo-outline" size={17} color={C.muted} style={{ marginLeft: 8 }} /></Pressable>}
                <Pressable onPress={() => patch(p.id, (y) => ({ steps: y.steps.filter((z) => z.id !== x.id) }))} hitSlop={8}><Icon n="close" size={15} color={C.muted} style={{ marginLeft: 8 }} /></Pressable>
              </View>
            ))}
            <View style={[s.addRow, { marginTop: 10, marginBottom: 0 }]}>
              <TextInput style={s.addInput} value={step[p.id] || ''} onChangeText={(t) => setStep((o) => ({ ...o, [p.id]: t }))} placeholder="Add a next action" placeholderTextColor={C.muted} keyboardAppearance="dark"
                onSubmitEditing={() => { const t = (step[p.id] || '').trim(); if (t) { patch(p.id, (y) => ({ steps: [...y.steps, { id: uid(), text: t, done: false }], touched: Date.now() })); setStep((o) => ({ ...o, [p.id]: '' })); } }} />
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

function RoutineList({ kind }) {
  const A = useApp();
  const [text, setText] = useState('');
  const steps = A.routineSteps(kind), done = A.routineDone(kind);
  const edit = (f) => A.setMeta((m) => { const r = m.routines || {}; return { ...m, routines: { ...r, [kind]: f(r[kind] || DEFAULT_ROUTINES[kind]) } }; });
  const streak = (() => { const d = (A.meta.routines || {}).done || {}; const ok = (k) => { const dn = (d[k] || {})[kind] || []; return steps.length > 0 && steps.every((x) => dn.includes(x.id)); }; let n = 0, o = ok(dayKey(0)) ? 0 : -1; while (ok(dayKey(o)) && n < 400) { n++; o--; } return n; })();
  return (
    <View>
      <View style={s.tiles}><Tile label="Done today" value={`${steps.filter((x) => done.includes(x.id)).length}/${steps.length}`} /><Tile label="Streak" value={`${streak}`} sub="days complete" /></View>
      {steps.map((x) => <Row key={x.id} title={x.text} check done={done.includes(x.id)} accent={C.online} onPress={() => A.routineToggle(kind, x.id)} onDelete={() => edit((l) => l.filter((y) => y.id !== x.id))} />)}
      <View style={s.addRow}><TextInput style={s.addInput} value={text} onChangeText={setText} placeholder="Add a step" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={() => { if (text.trim()) { edit((l) => [...l, { id: uid(), text: text.trim() }]); setText(''); } }} /><Pressable onPress={() => { if (text.trim()) { edit((l) => [...l, { id: uid(), text: text.trim() }]); setText(''); } }} style={[s.addBtn, !text.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
    </View>
  );
}
function Routines() {
  const [kind, setKind] = useState(new Date().getHours() < 15 ? 'morning' : 'evening');
  return (
    <Screen title="Routines" sub="Systems beat willpower. A fixed start and end to the day removes hundreds of small decisions." onBack={undefined}>
      <Chips opts={['morning', 'evening']} value={kind} onChange={setKind} show={(v) => (v === 'morning' ? 'Morning' : 'Evening')} />
      <RoutineList kind={kind} />
    </Screen>
  );
}

function Countdowns() {
  const [list, setList] = useMeta('countdowns', []);
  const [title, setTitle] = useState(''), [date, setDate] = useState('');
  const ok = title.trim() && validDate(date.trim());
  const add = () => { if (!ok) return; setList((l) => [...l, { id: uid(), title: title.trim(), date: date.trim() }].sort((a, b) => a.date.localeCompare(b.date))); setTitle(''); setDate(''); };
  return (
    <Screen title="Countdowns" sub="Deadlines and events you care about. Anything within two weeks shows on Today." onBack={undefined}>
      <Inp value={title} onChange={setTitle} ph="Event (e.g. Exam, Launch, Trip)" />
      <Inp value={date} onChange={setDate} ph="Date as YYYY-MM-DD" onSubmit={add} />
      <View style={s.chipRow}>{[7, 30, 90].map((n) => <Pressable key={n} onPress={() => setDate(dayKey(n))} style={[s.chip, { paddingVertical: 5 }]}><Text style={[s.chipText, { fontSize: 13 }]}>In {n} days</Text></Pressable>)}</View>
      <Btn label="Add countdown" icon="add" onPress={add} disabled={!ok} />
      {!!date.trim() && !validDate(date.trim()) && <Text style={[s.muted, { color: '#F87171', marginTop: 6 }]}>Use the format YYYY-MM-DD, for example {dayKey(30)}.</Text>}
      <Text style={s.section}>Coming up</Text>
      {list.length === 0 && <Text style={s.empty}>No countdowns yet.</Text>}
      {list.map((c) => { const n = daysUntil(c.date); return <Row key={c.id} title={c.title} sub={dLabel(c.date)} right={<Text style={[s.habitTitle, n < 0 && { color: C.muted }, n >= 0 && n <= 7 && { color: '#FBBF24' }]}>{n === 0 ? 'Today' : n > 0 ? `${n}d` : `${-n}d ago`}</Text>} onDelete={() => setList((l) => l.filter((x) => x.id !== c.id))} />; })}
    </Screen>
  );
}

/* ---------- Intelligence: briefing, levers, playbooks, search, hub, capture, retro ---------- */
function Briefing() {
  const A = useApp();
  const { meta } = A;
  const si = sleepInfo(meta), t = dayKey(0);
  const items = [];
  const push = (icon, title, text, go) => items.push({ icon, title, text, go });
  push('moon-outline', 'Sleep', si.last == null ? 'Not logged yet. Log it so your analytics stay accurate.' : `${hm(si.last)} last night. Sleep debt ${si.debt.toFixed(1)}h. Bedtime tonight: ${fmt(si.bedTonight)}.`, 'sleep');
  const pr = A.pk;
  push('flash-outline', 'Peak window', `${fmt(pr.start)} to ${fmt(pr.end)}${meta.peakOverride ? ' (from your energy map)' : ''}. Protect it for your hardest work.`, 'focus');
  if (A.plan) { const nx = A.plan.blocks.filter((b) => !b.done).slice(0, 3); push('calendar-outline', 'Plan', nx.length ? nx.map((b) => `${fmt(b.start)} ${b.title}`).join(' · ') : 'Every block is done. Excellent.', 'today'); }
  else push('calendar-outline', 'Plan', 'No plan yet. Build one with Coach or let the offline auto-planner do it on Today.', 'today');
  const iv = meta.ivy && meta.ivy.for === t ? meta.ivy : null;
  if (iv) { const ts = iv.ids.map((id) => A.tasks.find((x) => x.id === id)).filter((x) => x && !x.done); if (iv.one || ts.length) push('podium-outline', 'From last night', `${iv.one ? `The one thing: ${iv.one}. ` : ''}${ts.length ? `Start with: ${ts[0].title}.` : ''}`, 'today'); }
  const b3 = meta.big3 && meta.big3.wk === mondayKey(0) ? meta.big3.items : [];
  if (b3.length) push('podium-outline', 'Weekly Big 3', `${b3.filter((x) => x.done).length}/${b3.length} done: ${b3.map((x) => x.text).join(' · ')}`, 'big3');
  const left = A.habits.filter((h) => !h.log.includes(t)).length;
  if (A.habits.length) push('flame-outline', 'Habits', left ? `${left} of ${A.habits.length} still to check in today.` : 'All habits checked in.', 'habits');
  const due = A.cards.filter((c) => c.due <= t).length;
  if (due) push('albums-outline', 'Flashcards', `${due} due for review.`, 'learn');
  const dec = (meta.decisions || []).filter((d) => !d.outcome && d.review <= t).length;
  if (dec) push('scale-outline', 'Decisions', `${dec} ready to review and calibrate.`, 'decisions');
  const ppl = (meta.people || []).filter((p) => dueIn(p) <= 0);
  if (ppl.length) push('people-outline', 'People', `Reach out to ${ppl.slice(0, 3).map((p) => p.name).join(', ')}${ppl.length > 3 ? ` and ${ppl.length - 3} more` : ''}.`, 'people');
  const bd = (meta.people || []).map((p) => ({ p, n: bdayIn(p.bday) })).filter((x) => x.n !== null && x.n <= 7).sort((a, b) => a.n - b.n);
  if (bd.length) push('gift-outline', 'Birthdays', bd.map((x) => `${x.p.name} ${x.n === 0 ? 'today' : `in ${x.n}d`}`).join(' · '), 'people');
  const cd = (meta.countdowns || []).filter((c) => { const n = daysUntil(c.date); return n >= 0 && n <= 14; });
  if (cd.length) push('alarm-outline', 'Deadlines', cd.map((c) => `${c.title} (${daysUntil(c.date) === 0 ? 'today' : `${daysUntil(c.date)}d`})`).join(' · '), 'countdowns');
  const subs = (meta.subs || []).filter((x) => x.cycle !== 'year' && nextDay(x.day || 1) <= 3);
  if (subs.length) push('card-outline', 'Renewals', subs.map((x) => `${x.name} ${money(x.amt, meta.cur || '$')}`).join(' · ') + ' renewing within 3 days.', 'subs');
  if ((meta.budget || 0) > 0) { const sp = spentIn(meta.expenses || [], monthKey(0)); push('cash-outline', 'Budget', `${money(sp, meta.cur || '$')} of ${money(meta.budget, meta.cur || '$')} spent. About ${money(Math.max(0, (meta.budget - sp) / daysLeftMonth()), meta.cur || '$')} per day left.`, 'expenses'); }
  const md = MODELS[dayOfYear() % MODELS.length];
  push('construct-outline', 'Model of the day', `${md.name}: ${md.ask}`, 'models');
  const rules = ((meta.principles || {}).rules || []);
  if (rules.length) push('compass-outline', 'Your rule', rules[dayOfYear() % rules.length].text, 'principles');
  const text = items.map((x) => `${x.title}: ${x.text}`).join('\n');
  return (
    <Screen title="Daily briefing" sub={`${dLabel(t)}. Everything that matters today, in one place.`} onBack={undefined}>
      {items.map((x, i) => (
        <Pressable key={i} onPress={() => A.go(x.go)} style={[s.item, { alignItems: 'flex-start' }]}>
          <Icon n={x.icon} size={20} color={C.accent} style={{ marginRight: 12, marginTop: 2 }} />
          <View style={{ flex: 1 }}><Text style={[s.habitTitle, { flex: 0, fontSize: 15 }]}>{x.title}</Text><Text style={[s.muted, { marginTop: 2 }]}>{x.text}</Text></View>
          <Icon n="chevron-forward" size={16} color={C.muted} style={{ marginTop: 3 }} />
        </Pressable>
      ))}
      <Btn label={A.online ? 'Brief me and set my priorities with AI' : 'AI briefing needs a connection'} icon="sparkles-outline" disabled={!A.online} onPress={() => A.analyze(`Give me my morning briefing. Here is my situation right now:\n${text}\nTell me the 3 things that matter most today, what to protect, and what to ignore.`)} />
    </Screen>
  );
}

function Levers() {
  const A = useApp();
  const { rows, days } = leverInsights(A.meta, A.activity, A.habits);
  return (
    <Screen title="Leverage insights" sub={`Which behaviors go with your best days, from ${days} days of your own data. Correlation, not proof, but a strong place to experiment.`} onBack={undefined}>
      {rows.length === 0 && <Text style={s.empty}>Not enough data yet. Use the app for about two weeks and log sleep, workouts, water, focus and routines. The insights appear automatically.</Text>}
      {rows.map((r, i) => {
        const has = A.habits.some((h) => sameish(h.title, r.habit));
        return (
          <View key={r.id} style={[s.card, i === 0 && r.delta > 0 && { borderColor: C.online }]}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{r.label}</Text><Text style={[s.habitTitle, { flex: 0, color: r.delta > 0 ? C.online : '#F87171' }]}>{r.delta > 0 ? '+' : ''}{r.delta}</Text></View>
            <Text style={s.muted}>wins per day. {r.withAvg} on {r.nWith} days with it, {r.withoutAvg} on {r.nWithout} days without.</Text>
            {r.delta > 0.4 && !has && <Btn label="Make it a daily habit" kind="ghost" icon="add" onPress={() => { A.addHabit(r.habit, r.cat); A.toast('Habit added'); }} />}
          </View>
        );
      })}
    </Screen>
  );
}

function Playbooks() {
  const A = useApp();
  const groups = [...new Set(PLAYBOOKS.map((p) => p.g))];
  return (
    <Screen title="Coach playbooks" sub="Expert frameworks in one tap. Some run on your own data right away, others open the Coach with the start of a prompt for you to finish." onBack={undefined}>
      {groups.map((g) => (
        <View key={g}>
          <Text style={s.section}>{g}</Text>
          {PLAYBOOKS.filter((p) => p.g === g).map((p) => (
            <Pressable key={p.t} disabled={!A.online} onPress={() => (p.auto ? A.analyze(p.p) : A.draft(p.p))} style={[s.item, !A.online && { opacity: 0.4 }]}>
              <Icon n={p.auto ? 'flash-outline' : 'create-outline'} size={18} color={C.accent} style={{ marginRight: 12 }} />
              <Text style={s.itemText}>{p.t}</Text>
              <Text style={s.muted}>{p.auto ? 'runs now' : 'you add detail'}</Text>
            </Pressable>
          ))}
        </View>
      ))}
      {!A.online && <Text style={s.empty}>Playbooks need a connection.</Text>}
    </Screen>
  );
}

function SearchAll() {
  const A = useApp();
  const [q, setQ] = useState('');
  const m = A.meta, k = q.trim().toLowerCase();
  const hit = (x) => String(x || '').toLowerCase().includes(k);
  const groups = k.length < 2 ? [] : [
    ['Tasks', 'today', A.tasks.filter((x) => hit(x.title)).map((x) => x.title)],
    ['Habits', 'habits', A.habits.filter((x) => hit(x.title)).map((x) => x.title)],
    ['Notes', 'notes', (m.notes || []).filter((x) => hit(x.text)).map((x) => x.text)],
    ['Journal', 'journal', (m.journal || []).filter((x) => hit(x.text)).map((x) => x.text)],
    ['Books', 'books', (m.books || []).filter((x) => hit(x.title) || x.notes.some((n) => hit(n.text))).map((x) => x.title)],
    ['Decisions', 'decisions', (m.decisions || []).filter((x) => hit(x.title) || hit(x.why)).map((x) => x.title)],
    ['Goals', 'goals', (m.goals || []).filter((x) => hit(x.title)).map((x) => x.title)],
    ['Projects', 'projects', (m.projects || []).filter((x) => hit(x.title) || x.steps.some((z) => hit(z.text))).map((x) => x.title)],
    ['People', 'people', (m.people || []).filter((x) => hit(x.name) || hit(x.note)).map((x) => x.name)],
    ['Wins', 'wins', (m.winsV || []).filter((x) => hit(x.text)).map((x) => x.text)],
    ['Pre-mortems', 'premortem', (m.premortems || []).filter((x) => hit(x.proj) || hit(x.fail)).map((x) => x.proj)],
    ['Expenses', 'expenses', (m.expenses || []).filter((x) => hit(x.note) || hit(x.cat)).map((x) => `${x.note || x.cat} · ${money(x.amt, m.cur || '$')}`)],
    ['Principles', 'principles', [...((m.principles || {}).rules || []), ...((m.principles || {}).identity || [])].filter((x) => hit(x.text)).map((x) => x.text)],
    ['Tools', null, REG.filter((r) => hit(r.name) || hit(r.desc)).map((r) => r.name)],
  ].filter((g) => g[2].length);
  return (
    <Screen title="Search everything" sub="One box for every task, note, entry and tool." onBack={undefined}>
      <Inp value={q} onChange={setQ} ph="Search (2+ letters)" />
      {k.length >= 2 && groups.length === 0 && <Text style={s.empty}>No matches.</Text>}
      {groups.map(([name, go, list]) => (
        <View key={name}>
          <Text style={s.section}>{name} ({list.length})</Text>
          {list.slice(0, 6).map((txt, i) => <Pressable key={i} onPress={() => A.go(go || (REG.find((r) => r.name === txt) || {}).id || 'search')} style={s.item}><Text style={s.itemText} numberOfLines={2}>{txt}</Text><Icon n="chevron-forward" size={16} color={C.muted} /></Pressable>)}
        </View>
      ))}
    </Screen>
  );
}

function QuickCapture({ visible, onClose }) {
  const A = useApp();
  const [text, setText] = useState(''), [kind, setKind] = useState('task');
  useEffect(() => { if (visible) setText(''); }, [visible]);
  const save = () => {
    const t = text.trim();
    if (!t) return;
    if (kind === 'task') A.addTask(t, 'discipline');
    else if (kind === 'note') A.setMeta((m) => ({ ...m, notes: [{ id: uid(), ts: Date.now(), text: t, tag: 'idea', pin: false }, ...(m.notes || [])].slice(0, 1000) }));
    else if (kind === 'win') A.setMeta((m) => ({ ...m, winsV: [{ id: uid(), ts: Date.now(), text: t }, ...(m.winsV || [])].slice(0, 500) }));
    else {
      const mm = /^\s*([\d.,]+)\s*(.*)$/.exec(t);
      if (!mm || num(mm[1]) <= 0) { A.toast('Start with the amount, like "12.50 lunch"'); return; }
      A.setMeta((m) => ({ ...m, expenses: [{ id: uid(), ts: Date.now(), amt: num(mm[1]), cat: 'Other', note: mm[2].trim() }, ...(m.expenses || [])].slice(0, 3000) }));
    }
    A.toast(`Saved as ${kind}`); onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.modal}>
          <Text style={s.h1}>Quick capture</Text>
          <Text style={[s.muted, { marginVertical: 8 }]}>Get it out of your head in two seconds.</Text>
          <Chips opts={['task', 'note', 'win', 'expense']} value={kind} onChange={setKind} show={(v) => v[0].toUpperCase() + v.slice(1)} />
          <TextInput style={[s.keyInput, { minHeight: 70, textAlignVertical: 'top' }]} value={text} onChangeText={setText} multiline autoFocus placeholder={kind === 'expense' ? 'e.g. 12.50 lunch' : 'Type it here'} placeholderTextColor={C.muted} keyboardAppearance="dark" />
          <View style={[s.between, { marginTop: 16, justifyContent: 'flex-end' }]}>
            <Pressable style={s.ghost} onPress={onClose}><Text style={s.ghostText}>Cancel</Text></Pressable>
            <Pressable style={[s.ghost, { backgroundColor: text.trim() ? C.accent : C.disabled, marginLeft: 8 }]} onPress={save}><Text style={[s.ghostText, { color: C.onAccent }]}>Save</Text></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Retro() {
  const A = useApp();
  const [list, setList] = useMeta('retros', []);
  const [well, setWell] = useState(''), [fix, setFix] = useState(''), [next, setNext] = useState('');
  const wk = mondayKey(0), done = list.some((r) => r.wk === wk);
  const save = () => { if (!well.trim() && !fix.trim() && !next.trim()) return; setList((l) => [{ id: uid(), wk, ts: Date.now(), well: well.trim(), fix: fix.trim(), next: next.trim() }, ...l.filter((r) => r.wk !== wk)].slice(0, 52)); A.award('retro', 10); setWell(''); setFix(''); setNext(''); };
  return (
    <Screen title="Weekly retro" sub="Five minutes once a week is the highest-return habit in this app. Look back, adjust, repeat." onBack={undefined}>
      {done && <Text style={[s.muted, { color: C.online, marginBottom: 8 }]}>This week's retro is saved. Saving again replaces it.</Text>}
      <Label style={{ marginTop: 0 }}>What worked this week?</Label><Inp value={well} onChange={setWell} multi />
      <Label>What did not, and why?</Label><Inp value={fix} onChange={setFix} multi />
      <Label>One change for next week</Label><Inp value={next} onChange={setNext} />
      <Btn label="Save retro" icon="checkmark" onPress={save} />
      <Btn label="See my numbers first" kind="ghost" onPress={() => A.go('review')} />
      <Text style={s.section}>Past retros</Text>
      {list.length === 0 && <Text style={s.empty}>None yet.</Text>}
      {list.slice(0, 8).map((r) => (
        <View key={r.id} style={s.card}>
          <View style={s.between}><Text style={s.muted}>Week of {dLabel(r.wk)}</Text><Pressable onPress={() => setList((l) => l.filter((x) => x.id !== r.id))} hitSlop={10}><Icon n="close" size={17} color={C.muted} /></Pressable></View>
          {!!r.well && <Text style={[s.bubbleText, { marginTop: 6 }]}>Worked: {r.well}</Text>}
          {!!r.fix && <Text style={[s.bubbleText, { marginTop: 6 }]}>Didn't: {r.fix}</Text>}
          {!!r.next && <Text style={[s.bubbleText, { marginTop: 6 }]}>Change: {r.next}</Text>}
        </View>
      ))}
    </Screen>
  );
}

/* Consistency heatmap (12 weeks) for Stats */
function Heatmap({ activity }) {
  const days = Array.from({ length: 84 }, (_, i) => dayKey(-(83 - i)));
  const mx = Math.max(1, ...days.map((d) => activity[d] || 0));
  const shade = (n) => (n === 0 ? '#17171A' : n / mx > 0.75 ? '#22C55E' : n / mx > 0.5 ? '#16A34A' : n / mx > 0.25 ? '#15803D' : '#14532D');
  const cols = Array.from({ length: 12 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  const active = days.filter((d) => (activity[d] || 0) > 0).length;
  return (
    <View style={s.card}>
      <View style={s.between}><Text style={s.muted}>Consistency, last 12 weeks</Text><Text style={s.muted}>{active} active days</Text></View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 10 }}>
        {cols.map((c, i) => <View key={i}>{c.map((d) => <View key={d} style={[s.px, { backgroundColor: shade(activity[d] || 0), marginHorizontal: 2, marginVertical: 2 }]} />)}</View>)}
      </View>
    </View>
  );
}

/* Extra cards on Today: principle, Ivy list, weekly big 3, routine, countdowns */
function TodayExtras() {
  const A = useApp();
  const { meta } = A, t = dayKey(0), hr = new Date().getHours();
  const rules = [...((meta.principles || {}).rules || []), ...((meta.principles || {}).identity || [])];
  const rule = rules.length ? rules[dayOfYear() % rules.length].text : '';
  const iv = meta.ivy && meta.ivy.for === t ? meta.ivy : null;
  const ivTasks = iv ? iv.ids.map((id) => A.tasks.find((x) => x.id === id)).filter(Boolean) : [];
  const b3 = meta.big3 && meta.big3.wk === mondayKey(0) ? meta.big3.items : [];
  const kind = hr < 15 ? 'morning' : 'evening', steps = A.routineSteps(kind), done = A.routineDone(kind);
  const cds = (meta.countdowns || []).filter((c) => { const n = daysUntil(c.date); return n >= 0 && n <= 14; }).slice(0, 3);
  return (
    <View>
      {!!rule && <Text style={[s.muted, { fontStyle: 'italic', marginBottom: 12 }]}>"{rule}"</Text>}
      {cds.length > 0 && <View style={[s.chipRow, { marginBottom: 4 }]}>{cds.map((c) => { const n = daysUntil(c.date); return <Pressable key={c.id} onPress={() => A.go('countdowns')} style={[s.chip, { paddingVertical: 5 }, n <= 3 && { borderColor: '#FBBF24' }]}><Text style={[s.chipText, { fontSize: 13 }]}>{c.title}: {n === 0 ? 'today' : `${n}d`}</Text></Pressable>; })}</View>}
      {(iv && (ivTasks.length > 0 || !!iv.one)) && (
        <View style={s.card}>
          <Text style={s.muted}>Tomorrow's list, set last night</Text>
          {!!iv.one && <Text style={[s.habitTitle, { flex: 0, marginTop: 6 }]}>The one thing: {iv.one}</Text>}
          {ivTasks.map((x, i) => <Pressable key={x.id} onPress={() => A.toggleTask(x.id)} style={s.planRow}><View style={[s.check, { borderColor: C.accent }, x.done && { backgroundColor: C.accent }]}>{x.done ? <Icon n="checkmark" size={16} color={C.onAccent} /> : <Text style={{ color: C.accent, fontWeight: '800', fontSize: 13 }}>{i + 1}</Text>}</View><Text style={[s.itemText, x.done && s.done]}>{x.title}</Text></Pressable>)}
        </View>
      )}
      {b3.length > 0 && (
        <View style={s.card}>
          <Pressable onPress={() => A.go('big3')} style={s.between}><Text style={s.muted}>Weekly Big 3 · {b3.filter((x) => x.done).length}/{b3.length}</Text><Icon n="chevron-forward" size={14} color={C.muted} /></Pressable>
          {b3.map((x) => <Text key={x.id} style={[s.bubbleText, { marginTop: 6, fontSize: 15 }, x.done && s.done]}>{x.done ? '✓ ' : '○ '}{x.text}</Text>)}
        </View>
      )}
      {steps.length > 0 && (
        <View style={s.card}>
          <Pressable onPress={() => A.go('routines')} style={s.between}><Text style={s.muted}>{kind === 'morning' ? 'Morning' : 'Evening'} routine · {steps.filter((x) => done.includes(x.id)).length}/{steps.length}</Text><Icon n="chevron-forward" size={14} color={C.muted} /></Pressable>
          {steps.map((x) => <Pressable key={x.id} onPress={() => A.routineToggle(kind, x.id)} style={s.planRow}><View style={[s.check, { width: 22, height: 22, borderRadius: 11, borderColor: C.online }, done.includes(x.id) && { backgroundColor: C.online }]}>{done.includes(x.id) && <Icon n="checkmark" size={13} color="#000" />}</View><Text style={[s.itemText, { fontSize: 15 }, done.includes(x.id) && s.done]}>{x.text}</Text></Pressable>)}
        </View>
      )}
    </View>
  );
}

function AutoPlanButton() {
  const A = useApp();
  return (
    <Pressable onPress={A.autoPlanNow} style={s.planBtn}>
      <View style={s.btnRow}><Icon n="flash-outline" size={18} /><Text style={[s.planText, { marginLeft: 8 }]}>Auto-plan my day (works offline)</Text></View>
    </Pressable>
  );
}

function Fab({ onPress }) {
  const ins = useSafeAreaInsets();
  return (
    <Pressable onPress={onPress} accessibilityLabel="Quick capture" style={[s.fab, { bottom: 70 + ins.bottom }]}>
      <Icon n="add" size={28} color={C.onAccent} />
    </Pressable>
  );
}

/* ---------- Money: expenses, subscriptions, net worth, calculators ---------- */
const EXP_CATS = ['Food', 'Transport', 'Home', 'Health', 'Learning', 'Fun', 'Bills', 'Other'];
const CURRENCIES = ['$', '\u20AC', '\u00A3', '\u20B1', '\u00A5', '\u20B9'];
function CurChips() {
  const { meta, setMeta } = useApp();
  return <Chips opts={CURRENCIES} value={meta.cur || '$'} onChange={(c) => setMeta((m) => ({ ...m, cur: c }))} />;
}

function Expenses() {
  const A = useApp();
  const cur = A.meta.cur || '$', budget = A.meta.budget || 0;
  const [ex, setEx] = useMeta('expenses', []);
  const [amt, setAmt] = useState(''), [cat, setCat] = useState('Food'), [note, setNote] = useState(''), [bud, setBud] = useState('');
  const mk = monthKey(0), month = ex.filter((e) => keyOf(e.ts).slice(0, 7) === mk), spent = sum(month.map((e) => e.amt));
  const today = sum(ex.filter((e) => keyOf(e.ts) === dayKey(0)).map((e) => e.amt)), week = sum(ex.filter((e) => keyOf(e.ts) >= dayKey(-6)).map((e) => e.amt));
  const byCat = EXP_CATS.map((c) => ({ c, v: sum(month.filter((e) => e.cat === c).map((e) => e.amt)) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const perDay = budget ? Math.max(0, budget - spent) / daysLeftMonth() : 0;
  const add = () => { if (num(amt) <= 0) return; setEx((l) => [{ id: uid(), ts: Date.now(), amt: num(amt), cat, note: note.trim() }, ...l].slice(0, 3000)); A.award('expense', 2); setAmt(''); setNote(''); };
  return (
    <Screen title="Expenses" sub="What you track, you control. Log spending in seconds, see where it goes, and stay inside your budget." onBack={undefined}>
      <CurChips />
      <View style={s.tiles}>
        <Tile label="Today" value={money(today, cur)} />
        <Tile label="7 days" value={money(week, cur)} />
        <Tile label="This month" value={money(spent, cur)} color={budget && spent > budget ? '#F87171' : undefined} />
      </View>
      {budget > 0 && (
        <View style={s.card}>
          <View style={s.between}><Text style={s.muted}>Monthly budget</Text><Text style={s.muted}>{money(spent, cur)} / {money(budget, cur)}</Text></View>
          <Bar pct={(spent / budget) * 100} color={spent > budget ? '#F87171' : spent > budget * 0.8 ? '#FBBF24' : C.online} />
          <Text style={[s.muted, { fontSize: 12 }]}>{spent > budget ? `Over budget by ${money(spent - budget, cur)}.` : `About ${money(perDay, cur)} per day left for ${daysLeftMonth()} days.`}</Text>
        </View>
      )}
      <View style={{ flexDirection: 'row' }}>
        <Inp value={amt} onChange={setAmt} num ph={`Amount (${cur})`} style={{ flex: 1, marginRight: 8 }} />
        <Inp value={note} onChange={setNote} ph="Note (optional)" style={{ flex: 2 }} onSubmit={add} />
      </View>
      <Chips opts={EXP_CATS} value={cat} onChange={setCat} />
      <Btn label="Add expense" icon="add" onPress={add} disabled={num(amt) <= 0} />
      {byCat.length > 0 && <Text style={s.section}>This month by category</Text>}
      {byCat.length > 0 && <View style={s.card}>{byCat.map((x) => <View key={x.c} style={{ marginBottom: 2 }}><View style={s.between}><Text style={s.muted}>{x.c}</Text><Text style={s.muted}>{money(x.v, cur)} · {Math.round((100 * x.v) / spent)}%</Text></View><Bar pct={(x.v / byCat[0].v) * 100} /></View>)}</View>}
      <Text style={s.section}>Monthly budget</Text>
      <View style={s.addRow}><TextInput style={s.addInput} value={bud} onChangeText={setBud} keyboardType="decimal-pad" placeholder={budget ? `Currently ${money(budget, cur)}` : 'Set a monthly budget'} placeholderTextColor={C.muted} keyboardAppearance="dark" /><Pressable onPress={() => { if (num(bud) >= 0 && bud.trim()) { A.setMeta((m) => ({ ...m, budget: num(bud) })); setBud(''); } }} style={[s.addBtn, !bud.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Set</Text></Pressable></View>
      <Text style={s.section}>Recent</Text>
      {ex.length === 0 && <Text style={s.empty}>No expenses logged yet.</Text>}
      {ex.slice(0, 15).map((e) => <Row key={e.id} title={`${e.note || e.cat}`} sub={`${e.cat} · ${dLabel(keyOf(e.ts))}`} right={<Text style={s.habitTitle}>{money(e.amt, cur)}</Text>} onDelete={() => setEx((l) => l.filter((x) => x.id !== e.id))} />)}
    </Screen>
  );
}

function Subs() {
  const A = useApp();
  const cur = A.meta.cur || '$';
  const [subs, setSubs] = useMeta('subs', []);
  const [name, setName] = useState(''), [amt, setAmt] = useState(''), [cycle, setCycle] = useState('month'), [day, setDay] = useState('1');
  const monthly = sum(subs.map(subMonthly)), top = subs.slice().sort((a, b) => subMonthly(b) - subMonthly(a))[0];
  const add = () => { if (!name.trim() || num(amt) <= 0) return; setSubs((l) => [...l, { id: uid(), name: name.trim(), amt: num(amt), cycle, day: Math.max(1, Math.min(31, Math.round(num(day, 1)))) }]); setName(''); setAmt(''); };
  return (
    <Screen title="Subscriptions" sub="Small recurring costs quietly drain thousands a year. Put them all in one list." onBack={undefined}>
      <CurChips />
      <View style={s.tiles}>
        <Tile label="Per month" value={money(monthly, cur)} />
        <Tile label="Per year" value={money(monthly * 12, cur)} color={monthly > 0 ? '#FBBF24' : undefined} />
        <Tile label="Count" value={`${subs.length}`} />
      </View>
      <Inp value={name} onChange={setName} ph="Service (e.g. Streaming, Gym)" />
      <View style={{ flexDirection: 'row' }}>
        <Inp value={amt} onChange={setAmt} num ph={`Cost (${cur})`} style={{ flex: 1, marginRight: 8 }} />
        {cycle === 'month' && <Inp value={day} onChange={setDay} num ph="Renews on day" style={{ flex: 1 }} />}
      </View>
      <Chips opts={['month', 'year']} value={cycle} onChange={setCycle} show={(v) => (v === 'month' ? 'Monthly' : 'Yearly')} />
      <Btn label="Add subscription" icon="add" onPress={add} disabled={!name.trim() || num(amt) <= 0} />
      {top && subs.length > 1 && <Text style={[s.muted, { marginTop: 10 }]}>Biggest: {top.name} at {money(subMonthly(top) * 12, cur)} a year. Is it worth it?</Text>}
      <Text style={s.section}>Your subscriptions</Text>
      {subs.length === 0 && <Text style={s.empty}>None yet.</Text>}
      {subs.slice().sort((a, b) => subMonthly(b) - subMonthly(a)).map((x) => <Row key={x.id} title={x.name} sub={x.cycle === 'year' ? `Yearly · ${money(x.amt / 12, cur)}/month` : `Renews in ${nextDay(x.day || 1)} days`} right={<Text style={s.habitTitle}>{money(x.amt, cur)}</Text>} onDelete={() => setSubs((l) => l.filter((y) => y.id !== x.id))} />)}
    </Screen>
  );
}

function NetWorth() {
  const A = useApp();
  const cur = A.meta.cur || '$';
  const [nw, setNw] = useMeta('nw', { assets: [], debts: [], snaps: {} });
  const [name, setName] = useState(''), [amt, setAmt] = useState(''), [kind, setKind] = useState('assets');
  const assets = sum(nw.assets.map((x) => x.amt)), debts = sum(nw.debts.map((x) => x.amt)), net = assets - debts;
  const write = (f) => setNw((n) => { const nx = f({ ...n }); return { ...nx, snaps: { ...(n.snaps || {}), [monthKey(0)]: sum(nx.assets.map((x) => x.amt)) - sum(nx.debts.map((x) => x.amt)) } }; });
  const add = () => { if (!name.trim() || num(amt) < 0 || !amt.trim()) return; write((n) => ({ ...n, [kind]: [...n[kind], { id: uid(), name: name.trim(), amt: num(amt) }] })); setName(''); setAmt(''); };
  const sk = Object.keys(nw.snaps || {}).sort().slice(-12), vals = sk.map((k) => nw.snaps[k]), lo = Math.min(...vals), hi = Math.max(...vals);
  const prev = sk.length > 1 ? nw.snaps[sk[sk.length - 2]] : null;
  return (
    <Screen title="Net worth" sub="Assets minus debts, tracked monthly. Stored only on this device." onBack={undefined}>
      <CurChips />
      <View style={s.tiles}>
        <Tile label="Assets" value={money(assets, cur)} color={C.online} />
        <Tile label="Debts" value={money(debts, cur)} color={debts ? '#F87171' : undefined} />
        <Tile label="Net worth" value={money(net, cur)} sub={prev === null ? undefined : `${net - prev >= 0 ? '+' : '-'}${money(Math.abs(net - prev), cur)} vs last month`} />
      </View>
      <Chips opts={['assets', 'debts']} value={kind} onChange={setKind} show={(v) => (v === 'assets' ? 'Asset' : 'Debt')} />
      <Inp value={name} onChange={setName} ph={kind === 'assets' ? 'e.g. Savings, Index fund, Car' : 'e.g. Student loan, Card'} />
      <Inp value={amt} onChange={setAmt} num ph={`Value (${cur})`} onSubmit={add} />
      <Btn label={kind === 'assets' ? 'Add asset' : 'Add debt'} icon="add" onPress={add} disabled={!name.trim() || !amt.trim()} />
      {sk.length > 1 && (
        <View style={[s.card, { marginTop: 12 }]}>
          <Text style={s.muted}>Net worth by month</Text>
          <View style={s.bars}>{sk.map((k) => <View key={k} style={s.barCol}><View style={[s.bar, { width: 12, height: 8 + (hi === lo ? 30 : ((nw.snaps[k] - lo) / (hi - lo)) * 62), backgroundColor: k === monthKey(0) ? C.accent : '#3A3A3F' }]} /><Text style={[s.barLbl, { fontSize: 9 }]}>{k.slice(5)}</Text></View>)}</View>
        </View>
      )}
      {nw.assets.length > 0 && <Text style={s.section}>Assets</Text>}
      {nw.assets.map((x) => <Row key={x.id} title={x.name} right={<Text style={s.habitTitle}>{money(x.amt, cur)}</Text>} onDelete={() => write((n) => ({ ...n, assets: n.assets.filter((y) => y.id !== x.id) }))} />)}
      {nw.debts.length > 0 && <Text style={s.section}>Debts</Text>}
      {nw.debts.map((x) => <Row key={x.id} title={x.name} right={<Text style={[s.habitTitle, { color: '#F87171' }]}>{money(x.amt, cur)}</Text>} onDelete={() => write((n) => ({ ...n, debts: n.debts.filter((y) => y.id !== x.id) }))} />)}
    </Screen>
  );
}

function Calc() {
  const A = useApp();
  const cur = A.meta.cur || '$';
  const [p, setP] = useState('1000'), [c, setC] = useState('200'), [rate, setRate] = useState('7'), [yrs, setYrs] = useState('20');
  const [spend, setSpend] = useState(''), [saved, setSaved] = useState('0'), [save, setSave] = useState('500'), [ret, setRet] = useState('7');
  const [inc, setInc] = useState(''), [hrs, setHrs] = useState('160'), [price, setPrice] = useState('');
  const fv = futureValue(num(p), num(c), num(rate), num(yrs)), put = num(p) + num(c) * 12 * num(yrs), gain = fv - put;
  const target = num(spend) * 25, fy = target > 0 ? (num(saved) >= target ? 0 : yearsToTarget(target, num(saved), num(save), num(ret))) : null;
  const hourly = num(hrs) > 0 ? num(inc) / num(hrs) : 0;
  return (
    <Screen title="Wealth calculators" sub="Three numbers that change how you see money: compounding, your freedom number and what things cost in hours of your life." onBack={undefined}>
      <CurChips />
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Compound growth</Text>
        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Start</Label><Inp value={p} onChange={setP} num /></View>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Monthly</Label><Inp value={c} onChange={setC} num /></View>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Return %</Label><Inp value={rate} onChange={setRate} num /></View>
          <View style={{ flex: 1 }}><Label style={{ marginTop: 0 }}>Years</Label><Inp value={yrs} onChange={setYrs} num /></View>
        </View>
        <Text style={s.velocity}>{money(fv, cur)}</Text>
        <Text style={s.muted}>You put in {money(put, cur)}. Growth adds {money(Math.max(0, gain), cur)} ({fv > 0 ? Math.round((100 * Math.max(0, gain)) / fv) : 0}% of the total).</Text>
        <Text style={[s.muted, { fontSize: 12, marginTop: 4 }]}>Illustration only. Real returns vary and are not guaranteed.</Text>
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Financial independence number</Text>
        <Text style={[s.muted, { marginTop: 4 }]}>25 times yearly spending, the common "4% rule" rule of thumb.</Text>
        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Yearly spend</Label><Inp value={spend} onChange={setSpend} num /></View>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Saved</Label><Inp value={saved} onChange={setSaved} num /></View>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Per month</Label><Inp value={save} onChange={setSave} num /></View>
          <View style={{ flex: 1 }}><Label style={{ marginTop: 0 }}>Return %</Label><Inp value={ret} onChange={setRet} num /></View>
        </View>
        {target > 0 ? <><Text style={s.velocity}>{money(target, cur)}</Text><Text style={s.muted}>{fy === 0 ? 'You are already there.' : fy === null ? 'Not reachable within 100 years at these numbers. Raise savings or lower spending.' : `About ${r1(fy)} years at this pace.`}</Text></> : <Text style={[s.muted, { marginTop: 6 }]}>Enter your yearly spending to see your number.</Text>}
      </View>
      <View style={s.card}>
        <Text style={[s.habitTitle, { flex: 0 }]}>Time is money</Text>
        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Monthly take-home</Label><Inp value={inc} onChange={setInc} num /></View>
          <View style={{ flex: 1, marginRight: 8 }}><Label style={{ marginTop: 0 }}>Hours worked</Label><Inp value={hrs} onChange={setHrs} num /></View>
          <View style={{ flex: 1 }}><Label style={{ marginTop: 0 }}>Price</Label><Inp value={price} onChange={setPrice} num /></View>
        </View>
        {hourly > 0 ? <><Text style={s.velocity}>{money(hourly, cur)}<Text style={s.muted}> per hour</Text></Text>{num(price) > 0 && <Text style={s.bubbleText}>That purchase costs {r1(num(price) / hourly)} hours of your working life.</Text>}</> : <Text style={[s.muted, { marginTop: 6 }]}>Enter your income and hours to see your real hourly worth.</Text>}
      </View>
    </Screen>
  );
}

/* ---------- Growth: skills, people, wheel, life weeks, bucket list ---------- */
function Skills() {
  const A = useApp();
  const [skills, setSkills] = useMeta('skills', []);
  const [name, setName] = useState(''), [target, setTarget] = useState(100);
  const add = () => { if (!name.trim()) return; setSkills((l) => [...l, { id: uid(), name: name.trim(), target, log: {} }]); setName(''); };
  const logMin = (id, m) => { setSkills((l) => l.map((x) => (x.id === id ? { ...x, log: { ...x.log, [dayKey(0)]: Math.max(0, (x.log[dayKey(0)] || 0) + m) } } : x))); if (m > 0) A.award('skill', 4); };
  return (
    <Screen title="Skill tracker" sub="Deliberate practice hours compound. About 20 hours makes you functional, 100 competent, thousands excellent. Focus sessions can log here too." onBack={undefined}>
      <Inp value={name} onChange={setName} ph="Skill (e.g. Spanish, Python, Guitar)" onSubmit={add} />
      <Label style={{ marginTop: 0 }}>Hours goal</Label>
      <Chips opts={[20, 100, 500, 1000, 10000]} value={target} onChange={setTarget} show={(v) => `${commas(v)}h`} />
      <Btn label="Add skill" icon="add" onPress={add} disabled={!name.trim()} />
      {skills.map((x) => {
        const mins = skillMins(x), pace = sum(lastDays(14).map((d) => x.log[d] || 0)) / 14, left = x.target * 60 - mins, eta = pace > 0 && left > 0 ? Math.ceil(left / pace) : null;
        return (
          <View key={x.id} style={[s.card, { marginTop: 12 }]}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{x.name}</Text><Pressable onPress={() => setSkills((l) => l.filter((y) => y.id !== x.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
            <Bar pct={(mins / (x.target * 60)) * 100} color={mins >= x.target * 60 ? '#FBBF24' : C.accent} />
            <Text style={s.muted}>{r1(mins / 60)}h of {commas(x.target)}h · today {x.log[dayKey(0)] || 0} min{eta ? ` · about ${eta} days to go at your pace` : ''}</Text>
            <View style={[s.btnRow, { justifyContent: 'flex-start', marginTop: 10 }]}>
              {[15, 30, 60].map((m) => <Pressable key={m} onPress={() => logMin(x.id, m)} style={[s.logBtn, { marginRight: 8 }]}><Text style={s.logText}>+{m}m</Text></Pressable>)}
              <Pressable onPress={() => logMin(x.id, -15)} style={s.logBtn}><Text style={s.logText}>{'\u2212'}15m</Text></Pressable>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

function People() {
  const A = useApp();
  const [ppl, setPpl] = useMeta('people', []);
  const [name, setName] = useState(''), [cad, setCad] = useState(30), [bday, setBday] = useState(''), [note, setNote] = useState('');
  const bd = normMD(bday);
  const add = () => { if (!name.trim()) return; setPpl((l) => [...l, { id: uid(), name: name.trim(), cadence: cad, last: '', bday: bd, note: note.trim() }]); setName(''); setBday(''); setNote(''); };
  const touch = (id) => { setPpl((l) => l.map((x) => (x.id === id ? { ...x, last: dayKey(0) } : x))); A.award('people', 3); };
  const sorted = ppl.slice().sort((a, b) => dueIn(a) - dueIn(b));
  return (
    <Screen title="People" sub="Your network is your net worth. Decide how often you want to be in touch and the app reminds you." onBack={undefined}>
      <Inp value={name} onChange={setName} ph="Name" />
      <Inp value={note} onChange={setNote} ph="Context (optional): how you know them, what they care about" />
      <Label style={{ marginTop: 0 }}>Stay in touch every</Label>
      <Chips opts={[7, 14, 30, 90]} value={cad} onChange={setCad} show={(v) => `${v} days`} />
      <Inp value={bday} onChange={setBday} ph="Birthday as MM-DD (optional)" />
      {!!bday.trim() && !bd && <Text style={[s.muted, { color: '#F87171' }]}>Use MM-DD, for example 03-27.</Text>}
      <Btn label="Add person" icon="add" onPress={add} disabled={!name.trim()} />
      <Text style={s.section}>{ppl.filter((x) => dueIn(x) <= 0).length} due now</Text>
      {ppl.length === 0 && <Text style={s.empty}>Add the 5 people who matter most to your life and goals.</Text>}
      {sorted.map((x) => {
        const d = dueIn(x), b = bdayIn(x.bday);
        return (
          <View key={x.id} style={[s.card, d <= 0 && { borderColor: '#FBBF24' }]}>
            <View style={s.between}><Text style={[s.habitTitle, { flex: 1 }]}>{x.name}</Text><Pressable onPress={() => setPpl((l) => l.filter((y) => y.id !== x.id))} hitSlop={10}><Icon n="close" size={18} color={C.muted} /></Pressable></View>
            {!!x.note && <Text style={s.muted}>{x.note}</Text>}
            <Text style={s.muted}>Every {x.cadence} days · {x.last ? `last contact ${daysBetween(x.last, dayKey(0))} days ago` : 'not contacted yet'}{b !== null && b <= 30 ? ` · birthday ${b === 0 ? 'today' : `in ${b} day${b === 1 ? '' : 's'}`}` : ''}</Text>
            <View style={[s.between, { marginTop: 8 }]}>
              <Text style={[s.logText, { color: d <= 0 ? '#FBBF24' : C.online }]}>{d <= 0 ? (x.last ? `Overdue ${-d} days` : 'Reach out now') : `Next in ${d} days`}</Text>
              <Pressable onPress={() => touch(x.id)} style={s.logBtn}><Text style={s.logText}>I reached out</Text></Pressable>
            </View>
          </View>
        );
      })}
    </Screen>
  );
}

const WHEEL = ['Health', 'Career', 'Money', 'Relationships', 'Learning', 'Fun', 'Environment', 'Purpose'];
function LifeWheel() {
  const A = useApp();
  const [wh, setWh] = useMeta('wheel', { cur: {}, hist: [] });
  const cur = wh.cur || {}, hist = wh.hist || [];
  const v = (a) => cur[a] || 5, avg = sum(WHEEL.map(v)) / WHEEL.length, low = WHEEL.slice().sort((a, b) => v(a) - v(b))[0];
  const last = hist[0];
  const set = (a, n) => setWh((w) => ({ ...w, cur: { ...(w.cur || {}), [a]: Math.max(1, Math.min(10, n)) } }));
  const snap = () => { setWh((w) => ({ ...w, hist: [{ date: dayKey(0), avg: r1(avg), cur: Object.fromEntries(WHEEL.map((a) => [a, v(a)])) }, ...(w.hist || []).filter((h) => h.date !== dayKey(0))].slice(0, 24) })); A.award('wheel', 5); A.toast('Snapshot saved'); };
  return (
    <Screen title="Life wheel" sub="Rate 8 areas from 1 to 10, honestly. The lowest spoke limits how far the wheel rolls." onBack={undefined}>
      <View style={s.card}><View style={s.between}><Text style={s.muted}>Balance score</Text><Text style={s.h1}>{r1(avg)}</Text></View>{last && <Text style={s.muted}>{avg - last.avg >= 0 ? '+' : ''}{r1(avg - last.avg)} since {dLabel(last.date)}</Text>}</View>
      {WHEEL.map((a) => (
        <View key={a} style={s.card}>
          <View style={s.between}>
            <Text style={[s.habitTitle, { flex: 1 }]}>{a}{last && last.cur[a] !== undefined && v(a) !== last.cur[a] ? `  (${v(a) > last.cur[a] ? '+' : ''}${v(a) - last.cur[a]})` : ''}</Text>
            <View style={s.btnRow}>
              <Pressable onPress={() => set(a, v(a) - 1)} style={s.stepBtn} hitSlop={6}><Icon n="remove" size={18} /></Pressable>
              <Text style={[s.habitTitle, { flex: 0, width: 34, textAlign: 'center' }]}>{v(a)}</Text>
              <Pressable onPress={() => set(a, v(a) + 1)} style={s.stepBtn} hitSlop={6}><Icon n="add" size={18} /></Pressable>
            </View>
          </View>
          <Bar pct={v(a) * 10} color={a === low ? '#FBBF24' : C.accent} />
        </View>
      ))}
      <Text style={[s.muted, { marginBottom: 6 }]}>Lowest area right now: {low} ({v(low)}/10).</Text>
      <Btn label="Save snapshot" icon="checkmark" onPress={snap} />
      <Btn label={`Plan 30 days to lift ${low}`} kind="ghost" icon="sparkles-outline" disabled={!A.online} onPress={() => A.analyze(`My life wheel scores (1-10): ${WHEEL.map((a) => `${a} ${v(a)}`).join(', ')}. My lowest area is ${low}. Give me a realistic 30-day plan to raise it, using what you know about my schedule, habits and goals. Include one tiny daily action.`)} />
    </Screen>
  );
}

function LifeWeeks() {
  const A = useApp();
  const birth = A.meta.birth || '', exp = A.meta.lifeExp || 85;
  const [b, setB] = useState(birth);
  const ok = validDate(birth), st = ok ? lifeStats(birth, exp) : null;
  const whole = st ? Math.floor(st.years) : 0, frac = st ? st.years - whole : 0;
  return (
    <Screen title="Life in weeks" sub="Your time, made visible. Each square is one year of a typical life. This is not meant to scare you. It is meant to focus you." onBack={undefined}>
      <Inp value={b} onChange={setB} ph="Your birth date as YYYY-MM-DD" onSubmit={() => { if (validDate(b.trim())) A.setMeta((m) => ({ ...m, birth: b.trim() })); }} />
      <Btn label="Save birth date" kind="ghost" onPress={() => { if (validDate(b.trim()) && dateFrom(b.trim()) < new Date()) A.setMeta((m) => ({ ...m, birth: b.trim() })); else A.toast('Use a past date like 2001-04-23'); }} />
      <Label>Expected lifespan</Label>
      <Chips opts={[75, 80, 85, 90, 100]} value={exp} onChange={(n) => A.setMeta((m) => ({ ...m, lifeExp: n }))} />
      {st ? (
        <>
          <View style={[s.card, { alignItems: 'center' }]}>
            <View style={{ width: 10 * 22, flexDirection: 'row', flexWrap: 'wrap' }}>
              {Array.from({ length: exp }, (_, i) => <View key={i} style={[s.px, { backgroundColor: i < whole ? C.accent : '#17171A', opacity: i === whole ? 0.35 + 0.65 * frac : 1, borderWidth: i === whole ? 1 : 0, borderColor: C.accent }]} />)}
            </View>
          </View>
          <View style={s.tiles}>
            <Tile label="Lived" value={`${st.pct}%`} sub={`${commas(st.weeks)} weeks`} />
            <Tile label="Weeks left" value={commas(st.left)} sub="at this lifespan" />
            <Tile label="Summers left" value={`${Math.max(0, Math.floor(exp - st.years))}`} sub="roughly" />
          </View>
          <Text style={s.bubbleText}>About {commas(st.left)} Saturdays remain. If you read one book a month you have roughly {commas(Math.floor(st.left / 4.345))} books left in you. Spend them on purpose.</Text>
        </>
      ) : <Text style={s.empty}>Enter your birth date to see your life in years.</Text>}
    </Screen>
  );
}

function Bucket() {
  const A = useApp();
  const [list, setList] = useMeta('bucket', []);
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; setList((l) => [...l, { id: uid(), text: text.trim(), done: false, paid: false }]); setText(''); };
  const toggle = (x) => {
    setList((l) => l.map((y) => (y.id === x.id ? { ...y, done: !y.done, paid: y.paid || !y.done } : y)));
    if (!x.done && !x.paid) { A.setXp((v) => v + 15); A.toast('Checked off your bucket list. +15 XP'); }
  };
  const done = list.filter((x) => x.done).length;
  return (
    <Screen title="Bucket list" sub={`${done} of ${list.length} done. The things you will regret skipping, written down so they happen.`} onBack={undefined}>
      <View style={s.addRow}><TextInput style={s.addInput} value={text} onChangeText={setText} placeholder="Something you want to do or see" placeholderTextColor={C.muted} keyboardAppearance="dark" onSubmitEditing={add} /><Pressable onPress={add} style={[s.addBtn, !text.trim() && { backgroundColor: C.disabled }]}><Text style={s.addBtnText}>Add</Text></Pressable></View>
      {list.length === 0 && <Text style={s.empty}>Start with three things.</Text>}
      {list.map((x) => <Row key={x.id} title={x.text} check done={x.done} accent="#FBBF24" onPress={() => toggle(x)} onDelete={() => setList((l) => l.filter((y) => y.id !== x.id))} />)}
    </Screen>
  );
}

const SCREEN_MAP = {
  workout: Workout, nutrition: Nutrition, body: BodyMetrics, fasting: Fasting, breathe: BreatheScreen, meditate: MeditateScreen,
  math: MathSprint, stroop: Stroop, speed: SpeedReader, books: Books, notes: Notes, models: Models, decisions: Decisions, decide: DecisionMatrix, premortem: PreMortem,
  priority: PriorityMatrix, big3: Big3, projects: Projects, routines: Routines, timetrack: TimeTracker, energy: EnergyMap, shutdown: Shutdown, anti: AntiHabits, countdowns: Countdowns,
  briefing: Briefing, levers: Levers, playbooks: Playbooks, search: SearchAll, retro: Retro,
  expenses: Expenses, subs: Subs, networth: NetWorth, calc: Calc,
  skills: Skills, people: People, principles: Principles, wins: Wins, wheel: LifeWheel, lifeweeks: LifeWeeks, bucket: Bucket,
};
const SUB_IDS = ['sleep', 'journal', 'goals', 'badges', 'review', ...Object.keys(SCREEN_MAP)];

/* ---------- Life graph: every tool lives inside a feature and is wired to the others ----------
   Each tool has ONE home feature (a tab). The home tab shows it as a live row, ordered by what needs you first.
   EDGES lists only links that really exist in the code (data that one tool writes and another reads). */
const HOME = {
  // Habits: body and calm
  sleep: 'habits', workout: 'habits', nutrition: 'habits', body: 'habits', fasting: 'habits', breathe: 'habits', meditate: 'habits', anti: 'habits',
  // Today: run the day
  briefing: 'today', priority: 'today', big3: 'today', routines: 'today', shutdown: 'today', countdowns: 'today', goals: 'today',
  // Focus: work, skill and money
  timetrack: 'focus', energy: 'focus', projects: 'focus', skills: 'focus', math: 'focus', stroop: 'focus', expenses: 'focus', subs: 'focus', networth: 'focus', calc: 'focus',
  // Learn: think and learn
  books: 'learn', speed: 'learn', models: 'learn', decisions: 'learn', decide: 'learn', premortem: 'learn',
  // Dump: capture
  notes: 'dump',
  // Stats: see the whole system
  levers: 'stats', review: 'stats', retro: 'stats', wheel: 'stats', lifeweeks: 'stats', search: 'stats',
  // Coach
  playbooks: 'coach',
  // Me: identity and people
  journal: 'me', principles: 'me', wins: 'me', people: 'me', bucket: 'me', badges: 'me',
};
const TAB_NAME = { today: 'Today', habits: 'Habits', focus: 'Focus', learn: 'Learn', dump: 'Dump', stats: 'Stats', coach: 'Coach', me: 'Me' };
const HOSTS = {
  today: { title: 'Run the day', sub: 'Plan, priorities and shutdown feed each other.' },
  habits: { title: 'Body and calm', sub: 'What you log here shapes your plan, your peak window and your habits.' },
  focus: { title: 'Work, skill and money', sub: 'Time, energy and spending, tied to your focus sessions.' },
  learn: { title: 'Think and learn', sub: 'Reading, models and decisions that feed your goals.' },
  dump: { title: 'Second brain', sub: 'Everything you capture stays searchable.' },
  stats: { title: 'See the whole system', sub: 'The tools that read all your other data.' },
  me: { title: 'Identity and people', sub: 'Your rules, wins and relationships. Coach reads them all.' },
};
Object.keys(HOSTS).forEach((k) => { HOSTS[k].tools = REG.map((r) => r.id).filter((id) => HOME[id] === k); });

// Non-tool nodes that a connection can point at
const NODES = {
  focus: { name: 'Focus timer', go: 'focus' }, habits: { name: 'Habits', go: 'habits' }, today: { name: 'Today', go: 'today' },
  peak: { name: 'Peak window', go: 'today' }, score: { name: 'Day score', go: 'today' }, coach: { name: 'Coach', go: 'coach' },
};
const nodeOf = (id) => NODES[id] || (regOf(id) ? { name: regOf(id).name, go: id } : null);

const EDGES = [
  ['sleep', 'peak', 'a short night pushes your peak window later and shorter'],
  ['sleep', 'workout', 'a night under 6 hours makes Today suggest lighter training'],
  ['sleep', 'habits', 'a full night checks your sleep habit'],
  ['sleep', 'coach', 'Coach plans around your sleep debt'],
  ['sleep', 'levers', 'tested against your best days'],
  ['energy', 'peak', 'stands in for your peak window until focus sessions teach it'],
  ['focus', 'peak', 'finish times teach your peak window'],
  ['focus', 'skills', 'sessions log practice minutes to a skill'],
  ['focus', 'timetrack', 'sessions are added to your time log'],
  ['focus', 'habits', 'enough deep focus checks your focus habit'],
  ['focus', 'score', 'counts toward your day score'],
  ['workout', 'habits', 'a logged set checks your training habit'],
  ['workout', 'nutrition', 'a training day raises the protein reminder'],
  ['workout', 'levers', 'tested against your best days'],
  ['nutrition', 'habits', 'hitting your protein checks your protein habit'],
  ['nutrition', 'coach', 'Coach sees your calories and protein'],
  ['nutrition', 'levers', 'your protein target is tested against your best days'],
  ['breathe', 'habits', 'calm minutes check your calm habit'],
  ['breathe', 'levers', 'tested against your best days'],
  ['meditate', 'habits', 'calm minutes check your calm habit'],
  ['meditate', 'levers', 'tested against your best days'],
  ['stroop', 'focus', 'a one-minute warm-up before deep work'],
  ['math', 'focus', 'a one-minute warm-up before deep work'],
  ['journal', 'habits', 'an entry checks your journal habit'],
  ['journal', 'levers', 'tested against your best days'],
  ['shutdown', 'today', "sets tomorrow's one thing and list on Today"],
  ['shutdown', 'habits', 'finishing it checks your shutdown habit'],
  ['routines', 'today', 'your steps show on Today'],
  ['routines', 'habits', 'finishing the morning routine checks its habit'],
  ['routines', 'levers', 'your morning routine is tested against your best days'],
  ['big3', 'today', 'pinned on Today'],
  ['big3', 'coach', 'Coach sees your weekly outcomes'],
  ['goals', 'coach', 'Coach plans toward your goals'],
  ['projects', 'coach', 'Coach sees your next actions'],
  ['skills', 'coach', 'Coach sees your practice hours'],
  ['principles', 'coach', 'Coach uses your rules and identity'],
  ['wins', 'coach', 'Coach quotes them when you doubt yourself'],
  ['people', 'today', 'overdue contacts and birthdays become nudges'],
  ['people', 'coach', 'Coach sees who is overdue'],
  ['decisions', 'today', 'reviews that are due become nudges'],
  ['countdowns', 'today', 'close deadlines pin to Today'],
  ['expenses', 'today', 'going over budget becomes a nudge'],
  ['fasting', 'today', 'reaching your goal becomes a nudge'],
  ['levers', 'habits', 'turn a proven lever into a habit in one tap'],
  ['playbooks', 'coach', 'prompts that carry your real data into Coach'],
  ['notes', 'search', 'searchable from one box'],
  ['journal', 'search', 'searchable from one box'],
  ['books', 'search', 'searchable from one box'],
  ['decisions', 'search', 'searchable from one box'],
  ['goals', 'search', 'searchable from one box'],
  ['projects', 'search', 'searchable from one box'],
  ['people', 'search', 'searchable from one box'],
  ['wins', 'search', 'searchable from one box'],
  ['expenses', 'search', 'searchable from one box'],
  ['principles', 'search', 'searchable from one box'],
  ['sleep', 'badges', 'real activity here unlocks badges'],
  ['workout', 'badges', 'real activity here unlocks badges'],
  ['breathe', 'badges', 'real activity here unlocks badges'],
  ['meditate', 'badges', 'real activity here unlocks badges'],
  ['journal', 'badges', 'real activity here unlocks badges'],
  ['books', 'badges', 'real activity here unlocks badges'],
  ['skills', 'badges', 'real activity here unlocks badges'],
  ['decisions', 'badges', 'real activity here unlocks badges'],
  ['notes', 'badges', 'real activity here unlocks badges'],
  ['models', 'badges', 'real activity here unlocks badges'],
  ['people', 'badges', 'real activity here unlocks badges'],
  ['shutdown', 'badges', 'real activity here unlocks badges'],
  ['timetrack', 'badges', 'real activity here unlocks badges'],
  ['anti', 'badges', 'real activity here unlocks badges'],
  ['goals', 'badges', 'real activity here unlocks badges'],
  ['big3', 'briefing', 'your weekly outcomes lead the briefing'],
  ['decisions', 'briefing', 'reviews that are due appear in it'],
  ['shutdown', 'briefing', "tomorrow's one thing appears in it"],
];

/* Habits that check themselves: when a tool records the real thing, the matching habit is ticked once per day.
   Unticking is respected because each habit is only auto-ticked once a day. */
const minsIn = (title, d = 1) => { const m = /(\d+)\s*(?:min|minute)/i.exec(title); return m ? +m[1] : d; };
const AUTO = [
  { id: 'train', why: 'workout logged', cats: ['body'], re: /\b(train|workout|work out|gym|lift|lifting|exercise|cardio)\b/i, hit: (m, t) => (m.workouts || []).some((w) => keyOf(w.ts) === t) },
  { id: 'calm', why: 'calm practice logged', re: /\b(meditat\w*|breath\w*|mindful\w*)/i, hit: (m, t, h) => ((m.calm || {})[t] || 0) >= minsIn(h.title) },
  { id: 'journal', why: 'journal entry saved', re: /\b(journal\w*|gratitude)\b/i, hit: (m, t) => (m.journal || []).some((j) => j.date === t) },
  { id: 'sleep', why: 'sleep goal reached', re: /\bsleep\b.*\b(hours?|hrs?)\b|\b(hours?|hrs?)\b.*\bsleep\b/i, hit: (m, t) => ((m.sleep || {})[t] || 0) >= (m.sleepTarget || 8) },
  { id: 'water', why: 'water goal reached', re: /\b(water|hydrat\w*)/i, hit: (m, t) => ((m.water || {})[t] || 0) >= (m.waterGoal || 8) },
  { id: 'focus', why: 'deep focus done', re: /\b(focus|deep work)\b/i, hit: (m, t, h) => ((m.focusDays || {})[t] || 0) >= minsIn(h.title, 20) },
  { id: 'protein', why: 'protein target hit', re: /\bprotein\b/i, hit: (m, t) => { const p = (m.nut || {}).p; return !!p && sum((m.food || []).filter((f) => keyOf(f.ts) === t).map((f) => f.p || 0)) >= p; } },
  { id: 'plan', why: 'plan made', re: /\bplan (my|the|your)? ?day\b/i, hit: (m, t) => !!(m.plans || {})[t] },
  { id: 'shutdown', why: 'shutdown done', re: /\b(shut ?down|plan tomorrow)\b/i, hit: (m, t) => !!(m.shutdown || {})[t] },
  { id: 'morning', why: 'morning routine done', re: /\bmorning routine\b/i, hit: (m, t) => { const st = (m.routines || {}).morning || DEFAULT_ROUTINES.morning, dn = ((((m.routines || {}).done || {})[t]) || {}).morning || []; return st.length > 0 && st.every((x) => dn.includes(x.id)); } },
];
const autoFor = (h) => AUTO.find((a) => a.re.test(h.title) && (!a.cats || a.cats.includes(h.cat)));

/* Live one-line status for every tool, built from the same data the tools write */
const statusOf = (id, A) => {
  const m = A.meta, t = dayKey(0), hr = new Date().getHours(), cur = m.cur || '$';
  const mine = (list, f = 'ts') => (list || []).filter((x) => keyOf(x[f]) === t);
  const ok = (text, attn = 0) => ({ text, attn });
  switch (id) {
    case 'sleep': {
      const si = sleepInfo(m);
      if (m.sleepStart) return ok('Timer running. Open it when you wake up', 2);
      if (si.last == null) return ok(hr < 14 ? "Log last night's sleep" : 'Not logged today', hr >= 6 && hr < 14 ? 2 : 0);
      return ok(`${hm(si.last)} last night${si.debt > 0.5 ? `, ${r1(si.debt)}h debt this week` : ''}`, si.last < 6 ? 1 : 0);
    }
    case 'workout': {
      const w = mine(m.workouts), wk = new Set((m.workouts || []).filter((x) => keyOf(x.ts) >= dayKey(-6)).map((x) => keyOf(x.ts))).size;
      return ok(w.length ? `${w.length} set${w.length > 1 ? 's' : ''} today` : `${wk} training day${wk === 1 ? '' : 's'} in the last 7`);
    }
    case 'nutrition': {
      const f = mine(m.food), n = m.nut || {};
      return ok(f.length ? `${Math.round(sum(f.map((x) => x.cal || 0)))} of ${n.cal} kcal, ${Math.round(sum(f.map((x) => x.p || 0)))} of ${n.p} g protein` : `Nothing logged. Target ${n.cal || 2200} kcal, ${n.p || 140} g protein`, !f.length && hr >= 14 ? 1 : 0);
    }
    case 'body': {
      const b = m.body || {}, ks = Object.keys(b).filter((k) => b[k].w > 0).sort(), l = ks[ks.length - 1];
      return ok(l ? `${r1(b[l].w)} ${m.unit || 'kg'} on ${dLabel(l)}` : 'Log your weight to see the trend');
    }
    case 'fasting': {
      const f = m.fast;
      if (f && f.start) { const h = (Date.now() - f.start) / 36e5; return ok(`${r1(h)}h of ${f.goal || 16}h`, h >= (f.goal || 16) ? 2 : 0); }
      return ok('Not fasting');
    }
    case 'breathe': case 'meditate': {
      const c = (m.calm || {})[t] || 0, mo = (m.mood || {})[t];
      return ok(c ? `${r1(c)} min of calm today` : 'No calm practice yet today', !c && mo && (mo.e <= 2 || mo.m <= 2) ? 1 : 0);
    }
    case 'anti': {
      const a = m.anti || [];
      if (!a.length) return ok('Track what you refuse to do');
      const best = Math.max(0, ...a.map((x) => daysBetween((x.slips || []).slice().sort().pop() || x.start, t)));
      return ok(`${a.length} tracked, longest clean run ${best} day${best === 1 ? '' : 's'}`);
    }
    case 'math': case 'stroop': return ok('A one-minute warm-up that sharpens attention before deep work');
    case 'books': {
      const open = (m.books || []).filter((x) => !x.done);
      return ok(open.length ? `${open[0].title}: page ${open[0].page} of ${open[0].pages}` : `${(m.books || []).filter((x) => x.done).length} finished`);
    }
    case 'notes': return ok(`${(m.notes || []).length} notes captured`);
    case 'models': return ok(`${Object.keys(m.mmApplied || {}).length} of ${MODELS.length} applied`);
    case 'decisions': {
      const d = m.decisions || [], due = d.filter((x) => !x.outcome && x.review <= t).length, c = calib(d);
      return ok(due ? `${due} ready to review` : c ? `Calibration ${c.rate}% right across ${c.n}` : 'Log a call, review it later', due ? 1 : 0);
    }
    case 'premortem': return ok(`${(m.premortems || []).length} run`);
    case 'priority': { const o = A.tasks.filter((x) => !x.done); return ok(`${o.length} open, ${o.filter((x) => x.star).length} starred`); }
    case 'big3': {
      const b = m.big3 && m.big3.wk === mondayKey(0) ? m.big3.items : [];
      return ok(b.length ? `${b.filter((x) => x.done).length} of ${b.length} done this week` : 'Set three outcomes for the week', b.length ? 0 : 1);
    }
    case 'projects': {
      const p = (m.projects || []).filter((x) => (x.steps || []).some((z) => !z.done)), st = p.filter((x) => daysBetween(keyOf(x.touched), t) >= 7).length;
      return ok(p.length ? `${p.length} active${st ? `, ${st} stalled` : ''}` : 'Give every outcome a next action', st ? 1 : 0);
    }
    case 'routines': {
      const kind = hr < 15 ? 'morning' : 'evening', st = A.routineSteps(kind), dn = A.routineDone(kind);
      return ok(`${kind === 'morning' ? 'Morning' : 'Evening'}: ${dn.length} of ${st.length} steps`, kind === 'morning' && hr >= 7 && dn.length < st.length ? 1 : 0);
    }
    case 'timetrack': {
      if (m.timer) return ok(`Tracking ${m.timer.label}`, 1);
      const tl = mine(m.timeLog, 'end');
      return ok(tl.length ? `${r1(sum(tl.map((x) => x.mins)))} min tracked today` : 'See where your hours go');
    }
    case 'energy': {
      const e = m.energy || [], b = bestEnergy(e);
      return ok(b ? `Best hours ${fmt(b.start)} to ${fmt(b.end)}` : `${e.length} of 10 taps to find your peak`);
    }
    case 'shutdown': { const d = !!(m.shutdown || {})[t]; return ok(d ? 'Done. Tomorrow is set' : 'Set tomorrow up tonight', !d && hr >= 20 ? 2 : 0); }
    case 'countdowns': {
      const c = (m.countdowns || []).map((x) => ({ x, n: daysUntil(x.date) })).filter((o) => o.n >= 0).sort((a, b) => a.n - b.n)[0];
      return ok(c ? `${c.x.title} ${c.n === 0 ? 'is today' : `in ${c.n} day${c.n > 1 ? 's' : ''}`}` : 'Deadlines and events', c && c.n <= 3 ? 1 : 0);
    }
    case 'goals': {
      const g = (m.goals || []).filter((x) => !x.done);
      return ok(g.length ? `${g.length} active. ${g[0].title}: ${g[0].current} of ${g[0].target}` : 'Set a target with a number');
    }
    case 'briefing': return ok('Everything that matters today, in one read');
    case 'levers': {
      const r = leverInsights(m, A.activity, A.habits).rows;
      return ok(r.length ? `Top lever: ${r[0].label.toLowerCase()}, +${r[0].delta} wins a day` : 'Needs about two weeks of data');
    }
    case 'review': return ok('Your week in numbers');
    case 'retro': {
      const d = (m.retros || []).some((x) => x.wk === mondayKey(0));
      return ok(d ? 'This week is saved' : 'Look back, adjust, repeat', !d && new Date().getDay() === 0 ? 1 : 0);
    }
    case 'wheel': { const h = (m.wheel || {}).hist || []; return ok(h.length ? `Balance ${h[0].avg} on ${dLabel(h[0].date)}` : 'Rate 8 areas of life'); }
    case 'lifeweeks': return ok(validDate(m.birth || '') ? `${commas(lifeStats(m.birth, m.lifeExp || 85).left)} weeks left at ${m.lifeExp || 85}` : 'Add your birthday to see it');
    case 'search': return ok('Find any task, note or entry');
    case 'playbooks': return ok(`${PLAYBOOKS.length} prompts, ${PLAYBOOKS.filter((p) => p.auto).length} use your data`);
    case 'expenses': {
      const sp = spentIn(m.expenses || [], monthKey(0)), b = m.budget || 0;
      return ok(`${money(sp, cur)} this month${b > 0 ? ` of ${money(b, cur)}` : ''}`, b > 0 && sp > b ? 2 : 0);
    }
    case 'subs': { const tot = sum((m.subs || []).map((x) => subMonthly(x))); return ok(tot ? `${money(tot, cur)} a month, ${money(tot * 12, cur)} a year` : 'What you pay every month'); }
    case 'networth': {
      const n = m.nw || {}, v = sum((n.assets || []).map((x) => x.amt)) - sum((n.debts || []).map((x) => x.amt));
      return ok((n.assets || []).length || (n.debts || []).length ? `Net ${money(v, cur)}` : 'Assets minus debts, tracked monthly');
    }
    case 'skills': { const sk = m.skills || []; return ok(sk.length ? `${r1(sum(sk.map((x) => skillMins(x))) / 60)}h across ${sk.length} skill${sk.length > 1 ? 's' : ''}` : 'Track deliberate practice hours'); }
    case 'people': { const p = (m.people || []).filter((x) => dueIn(x) <= 0).length; return ok(p ? `${p} overdue for contact` : `${(m.people || []).length} tracked`, p ? 1 : 0); }
    case 'principles': { const p = m.principles || {}; return ok(`${(p.rules || []).length} rules, ${(p.identity || []).length} identity statements`); }
    case 'journal': { const w = (m.journal || []).some((x) => x.date === t); return ok(w ? 'Written today' : `${(m.journal || []).length} entries`, !w && hr >= 19 ? 1 : 0); }
    case 'wins': return ok(`${(m.winsV || []).length} stored`);
    case 'bucket': { const b = m.bucket || []; return ok(`${b.filter((x) => x.done).length} of ${b.length} done`); }
    case 'badges': return ok(`${(m.badges || []).length} unlocked`);
    default: return ok(regOf(id) ? regOf(id).desc : '');
  }
};
const toolStatus = (id, A) => {
  try { return statusOf(id, A); } catch (e) { const r = regOf(id); return { text: r ? r.desc : '', attn: 0 }; }
};

/* Cross-feature insights: each one reads data from a different tool than the tab it appears on */
const signalsFor = (host, A) => {
  try {
    const m = A.meta, t = dayKey(0), out = [], pk = A.pk, si = sleepInfo(m);
    const due = A.cards.filter((c) => c.due <= t).length;
    const decDue = (m.decisions || []).filter((x) => !x.outcome && x.review <= t).length;
    const ppl = (m.people || []).filter((p) => dueIn(p) <= 0).length;
    const lever = () => leverInsights(m, A.activity, A.habits).rows[0];
    if (host === 'habits') {
      if (si.last != null) out.push({ icon: 'moon-outline', text: `Last night ${hm(si.last)}. Your peak window today is ${fmt(pk.start)} to ${fmt(pk.end)}.`, go: 'sleep' });
      const edge = sleepEdge(m, A.activity);
      if (edge !== null && Math.abs(edge) >= 0.5) out.push({ icon: 'analytics-outline', text: `On nights with 7h or more you finish ${r1(Math.abs(edge))} ${edge >= 0 ? 'more' : 'fewer'} wins a day.`, go: 'levers' });
      const auto = A.habits.filter((h) => autoFor(h));
      if (auto.length) out.push({ icon: 'link-outline', text: `${auto.length} habit${auto.length > 1 ? 's' : ''} ${auto.length > 1 ? 'check themselves' : 'checks itself'} when you log the real thing: ${auto.slice(0, 3).map((h) => h.title).join(', ')}.` });
      const lv = lever();
      if (lv && lv.delta > 0.4) out.push({ icon: 'flash-outline', text: `Your best lever: ${lv.label.toLowerCase()}, +${lv.delta} wins on those days.`, go: 'levers' });
    } else if (host === 'today') {
      const wait = [];
      if (due) wait.push([`${due} flashcard${due > 1 ? 's' : ''}`, 'learn']);
      if (decDue) wait.push([`${decDue} decision${decDue > 1 ? 's' : ''}`, 'decisions']);
      if (ppl) wait.push([`${ppl} ${ppl > 1 ? 'people' : 'person'}`, 'people']);
      if (wait.length) out.push({ icon: 'albums-outline', text: `Waiting on you: ${wait.map((w) => w[0]).join(', ')}.`, go: wait[0][1] });
      const lv = lever();
      if (lv && lv.delta > 0.4) out.push({ icon: 'flash-outline', text: `Your best lever: ${lv.label.toLowerCase()}, +${lv.delta} wins on those days.`, go: 'levers' });
    } else if (host === 'focus') {
      const tl = (m.timeLog || []).filter((x) => keyOf(x.end) === t), tm = r1(sum(tl.map((x) => x.mins))), fm = (m.focusDays || {})[t] || 0;
      const src = pk.src === 'energy' ? ' from your energy taps' : pk.src === 'focus' ? ' learned from your sessions' : '';
      out.push({ icon: 'flash-outline', text: `Peak window ${fmt(pk.start)} to ${fmt(pk.end)}${src}. Put the hardest work inside it.`, go: 'energy' });
      if (fm || tm) out.push({ icon: 'time-outline', text: `${fm} min of deep focus and ${tm} min tracked today. Sessions land in your time log and skill hours by themselves.`, go: 'timetrack' });
      out.push({ icon: 'sparkles-outline', text: 'Warm up first: a 60-second Stroop drill sharpens attention before deep work.', go: 'stroop' });
      const sk = (m.skills || []).filter((x) => x.target > 0 && skillMins(x) / 60 < x.target).sort((a, b) => skillMins(b) / b.target - skillMins(a) / a.target)[0];
      if (sk) out.push({ icon: 'school-outline', text: `${sk.name}: ${r1(skillMins(sk) / 60)}h of ${sk.target}h. Pick it as your session skill.`, go: 'skills' });
      if ((m.budget || 0) > 0) { const left = m.budget - spentIn(m.expenses || [], monthKey(0)); out.push({ icon: 'cash-outline', text: left >= 0 ? `${money(left / daysLeftMonth(), m.cur || '$')} a day left in this month's budget.` : 'Over budget this month. Income work compounds fastest right now.', go: 'expenses' }); }
    } else if (host === 'learn') {
      out.push({ icon: 'flash-outline', text: `Study the hard material at ${fmt(pk.start)}, inside your peak window.`, go: 'focus' });
      if (decDue) out.push({ icon: 'scale-outline', text: `${decDue} decision${decDue > 1 ? 's' : ''} ready for review. Close the loop to sharpen your judgment.`, go: 'decisions' });
      const bk = (m.books || []).find((b) => !b.done && b.page > 0);
      if (bk) out.push({ icon: 'library-outline', text: `${bk.title} is ${Math.round((100 * bk.page) / bk.pages)}% done. Twenty minutes today keeps the pace.`, go: 'books' });
    } else if (host === 'stats') {
      const lv = lever();
      if (lv && lv.delta > 0.4) out.push({ icon: 'flash-outline', text: `Your best lever: ${lv.label.toLowerCase()}, +${lv.delta} wins on those days.`, go: 'levers' });
      const cur = (m.wheel || {}).cur || {}, ks = Object.keys(cur);
      if (ks.length) { const low = ks.sort((a, b) => cur[a] - cur[b])[0]; out.push({ icon: 'aperture-outline', text: `Your life wheel's weakest area is ${low} (${cur[low]} of 10). Add one habit that lifts it.`, go: 'wheel' }); }
    } else if (host === 'me') {
      if (ppl) out.push({ icon: 'people-outline', text: `${ppl} ${ppl > 1 ? 'people are' : 'person is'} overdue for contact.`, go: 'people' });
      if ((m.winsV || []).length) out.push({ icon: 'medal-outline', text: `${(m.winsV || []).length} wins stored. Coach quotes them when you doubt yourself.`, go: 'wins' });
      const p = m.principles || {};
      if ((p.rules || []).length || (p.identity || []).length) out.push({ icon: 'compass-outline', text: 'Your rules and identity shape every Coach answer and appear on Today.', go: 'principles' });
    }
    return out.slice(0, 4);
  } catch (e) { return []; }
};

/* Inline tools: a live section on the feature that owns them, most urgent first */
function Shelf({ host }) {
  const A = useApp();
  const [all, setAll] = useState(false);
  const cfg = HOSTS[host];
  if (!cfg) return null;
  const rows = cfg.tools.map((id, i) => ({ r: regOf(id), st: toolStatus(id, A), i })).filter((x) => x.r)
    .sort((a, b) => b.st.attn - a.st.attn || a.i - b.i);
  const shown = all ? rows : rows.slice(0, 4);
  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={s.section}>{cfg.title}</Text>
      <Text style={[s.muted, { marginTop: -6, marginBottom: 10 }]}>{cfg.sub}</Text>
      {shown.map(({ r, st }) => (
        <Pressable key={r.id} onPress={() => A.go(r.id)} style={[s.item, st.attn > 1 && { borderColor: C.accent }]}>
          <Icon n={r.icon} size={20} color={st.attn ? C.accent : C.muted} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={[s.itemText, { fontSize: 15, flex: 0 }]}>{r.name}</Text>
            <Text style={[s.muted, { fontSize: 12, lineHeight: 16 }]} numberOfLines={2}>{st.text}</Text>
          </View>
          <Icon n="chevron-forward" size={16} color={C.muted} />
        </Pressable>
      ))}
      {rows.length > 4 && (
        <Pressable onPress={() => setAll(!all)} style={{ alignSelf: 'flex-start', paddingVertical: 6 }} hitSlop={8}>
          <Text style={s.muted}>{all ? 'Show fewer' : `${rows.length - 4} more in ${cfg.title.toLowerCase()}`}</Text>
        </Pressable>
      )}
    </View>
  );
}

/* One card per feature that shows how it ties into the rest of your data */
function Signals({ host }) {
  const A = useApp();
  const list = signalsFor(host, A);
  if (!list.length) return null;
  return (
    <View style={s.card}>
      <View style={[s.btnRow, { justifyContent: 'flex-start', marginBottom: 4 }]}><Icon n="link-outline" size={16} color={C.muted} /><Text style={[s.muted, { marginLeft: 6 }]}>Connected to the rest of your life</Text></View>
      {list.map((x, i) => (
        <Pressable key={i} disabled={!x.go} onPress={() => A.go(x.go)} style={[s.planRow, { paddingHorizontal: 0 }]}>
          <Icon n={x.icon} size={16} color={C.accent} style={{ marginRight: 10 }} />
          <Text style={[s.itemText, { fontSize: 14 }]}>{x.text}</Text>
          {!!x.go && <Icon n="chevron-forward" size={14} color={C.muted} />}
        </Pressable>
      ))}
    </View>
  );
}

/* Footer on every tool screen: what feeds it and what it feeds */
function Links({ id }) {
  const A = useApp();
  const outs = EDGES.filter((e) => e[0] === id).map(([, to, how]) => ({ n: nodeOf(to), how })).filter((x) => x.n);
  const ins = EDGES.filter((e) => e[1] === id).map(([from, , how]) => ({ n: nodeOf(from), how })).filter((x) => x.n);
  if (!outs.length && !ins.length) return null;
  const row = (x, i, icon) => (
    <Pressable key={`${icon}${i}`} onPress={() => A.go(x.n.go)} style={[s.planRow, { paddingHorizontal: 0 }]}>
      <Icon n={icon} size={15} color={C.accent} style={{ marginRight: 10 }} />
      <Text style={[s.itemText, { fontSize: 14 }]}><Text style={{ fontWeight: '700' }}>{x.n.name}</Text>: {x.how}</Text>
      <Icon n="chevron-forward" size={14} color={C.muted} />
    </Pressable>
  );
  return (
    <View style={[s.card, { marginTop: 16 }]}>
      <View style={[s.btnRow, { justifyContent: 'flex-start' }]}><Icon n="link-outline" size={16} color={C.muted} /><Text style={[s.muted, { marginLeft: 6 }]}>How this connects</Text></View>
      {outs.length > 0 && <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>Feeds</Text>}
      {outs.slice(0, 4).map((x, i) => row(x, i, 'arrow-forward-outline'))}
      {ins.length > 0 && <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>Fed by</Text>}
      {ins.slice(0, 4).map((x, i) => row(x, i, 'arrow-back-outline'))}
    </View>
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
      <TodayExtras />

      <Signals host="today" />
      <Shelf host="today" />


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

      <AutoPlanButton />

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
      <Signals host="habits" />
      <Shelf host="habits" />
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
      <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>{pk.custom ? 'Set from your own energy map.' : pk.learned ? 'Learned from when you actually finish focus sessions.' : 'Estimated from your wake time and sleep. Learns your real peak after 3 focus sessions.'}</Text>
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
      <Signals host="learn" />
      <Shelf host="learn" />
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
      <Shelf host="dump" />
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

      <Heatmap activity={activity} />
      <Signals host="stats" />
      <Shelf host="stats" />
      <ReactionTest rt={meta.rt || []} onSave={(ms) => setMeta((mt) => ({ ...mt, rt: [...(mt.rt || []), ms].slice(-20) }))} />
      <SpanTest best={meta.span} onResult={(n) => setMeta((mt) => ({ ...mt, span: Math.max(mt.span || 0, n) }))} />

      <Pressable disabled={!online} onPress={() => onAnalyze(summary)} style={[s.wide, { backgroundColor: C.accent, opacity: online ? 1 : 0.4, maxWidth: '100%' }]}>
        <View style={s.btnRow}><Icon n="sparkles-outline" size={18} color={C.onAccent} /><Text style={[s.addBtnText, { marginLeft: 8 }]}>{online ? 'AI performance review of my stats' : 'AI review needs a connection'}</Text></View>
      </Pressable>
    </ScrollView>
  );
}

/* ---------- Focus ---------- */
function Focus({ onDone, suggest, log, skills = [] }) {
  const [mins, setMins] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [brk, setBrk] = useState(false);
  const [intent, setIntent] = useState('');
  const [msg, setMsg] = useState('');
  const [skill, setSkill] = useState('');
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
      else { onDone(mins, intent.trim(), skill); setLeft(mins * 60); setMsg(`Session complete. +15 XP for ${mins} focused minutes.`); }
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
      <TextInput style={[s.addInput, { flex: 0, marginTop: 4 }]} value={intent} onChangeText={setIntent} editable={!running} placeholder="What will you work on? (optional)" placeholderTextColor={C.muted} keyboardAppearance="dark" />
      {!!suggest && !intent && !running && (
        <Pressable onPress={() => setIntent(suggest)} style={[s.chip, { alignSelf: 'flex-start', marginTop: 8 }]}><Text style={[s.chipText, { fontSize: 13 }]}>Use plan: {suggest}</Text></Pressable>
      )}
      {skills.length > 0 && !running && (
        <View style={{ marginTop: 10 }}>
          <Text style={s.muted}>Count this session toward a skill</Text>
          <View style={[s.chipRow, { marginTop: 6 }]}>
            {[{ id: '', name: 'None' }, ...skills].map((x) => (
              <Pressable key={x.id || 'none'} onPress={() => setSkill(x.id)} style={[s.chip, { paddingVertical: 5 }, skill === x.id && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={[s.chipText, { fontSize: 13 }]}>{x.name}</Text></Pressable>
            ))}
          </View>
        </View>
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
      {!running && <Signals host="focus" />}
      {!running && <Shelf host="focus" />}
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
      <Signals host="me" />
      <Shelf host="me" />
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

function Coach({ online, hasKey, messages, thinking, mode, setMode, onSend, onOpenSettings, onClear, acts, draft }) {
  const A = useApp();
  const [input, setInput] = useState('');
  useEffect(() => { if (draft && draft.text) setInput(draft.text); }, [draft && draft.n]);
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
            <Pressable onPress={() => A.go('playbooks')} style={s.suggest}>
              <Text style={s.chipText}>Browse expert playbooks</Text>
            </Pressable>
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
  const [backTo, setBackTo] = useState('today');
  const [capture, setCapture] = useState(false);
  const [coachDraft, setCoachDraft] = useState(null);
  const awardRef = useRef({});
  const autoRef = useRef({});
  const { width: winW } = useWindowDimensions();
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
    if (!tasksRef.current.some(due)) return;
    setTasks((p) => p.map((x) => (due(x) ? { ...x, done: false, doneOn: undefined } : x)));
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
  const finishFocus = (m, intent = '', skillId = '') => {
    const h = new Date(Date.now() - m * 60000).getHours();
    setXp((x) => x + 15); setFocusMin((f) => f + m); bump(1);
    setMeta((mt) => ({
      ...mt,
      hours: { ...mt.hours, [h]: (mt.hours[h] || 0) + 1 },
      focusDays: { ...mt.focusDays, [dayKey(0)]: ((mt.focusDays || {})[dayKey(0)] || 0) + m },
      focusLog: [...(mt.focusLog || []), { ts: Date.now(), mins: m, intent }].slice(-80),
      // A finished session is also real tracked time
      timeLog: [{ id: uid(), start: Date.now() - m * 60000, end: Date.now(), mins: m, label: intent || 'Deep focus', cat: intent && GUESS.some(([, re]) => re.test(intent)) ? guessCat(intent) : 'career' }, ...(mt.timeLog || [])].slice(0, 500),
      ...(skillId ? { skills: (mt.skills || []).map((x) => (x.id === skillId ? { ...x, log: { ...x.log, [dayKey(0)]: ((x.log || {})[dayKey(0)] || 0) + m } } : x)) } : {}),
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
  // Habits tick themselves when a tool records the real thing. Each habit is auto-ticked once a day, so unticking sticks.
  useEffect(() => {
    if (!loaded) return;
    const t = dayKey(0), seen = (meta.linked || {})[t] || [], hits = [];
    habits.forEach((h) => {
      if (h.log.includes(t) || seen.includes(h.id) || autoRef.current[`${t}|${h.id}`]) return;
      const a = autoFor(h);
      if (a && a.hit(meta, t, h)) hits.push({ h, a });
    });
    if (!hits.length) return;
    hits.forEach(({ h }) => { autoRef.current[`${t}|${h.id}`] = true; });
    const ids = hits.map((x) => x.h.id);
    setHabits((p) => p.map((x) => (ids.includes(x.id) && !x.log.includes(t) ? { ...x, log: [...x.log, t] } : x)));
    setXp((x) => x + 5 * ids.length);
    bump(ids.length);
    ids.forEach((id) => syncBlocks('habitId', id, true));
    setMeta((m) => ({ ...m, linked: { ...pruneDays(m.linked, 14), [t]: [...(((m.linked || {})[t]) || []), ...ids] } }));
    showToast(hits.length === 1 ? `${hits[0].h.title} checked: ${hits[0].a.why}` : `${hits.length} habits checked from your activity`, () => ids.forEach((id) => toggleHabit(id)));
  }, [meta, habits, loaded]);
  const saveJournal = (text, prompt) => {
    const k = dayKey(0), first = !(meta.journal || []).some((j) => j.date === k);
    setMeta((m) => ({ ...m, journal: [{ id: uid(), date: k, ts: Date.now(), text, prompt }, ...(m.journal || [])].slice(0, 300) }));
    if (first) { setXp((x) => x + 5); bump(1); }
  };

  /* Life OS helpers shared with the new screens */
  const award = (key, amt = 5) => {
    const k = dayKey(0), rk = `${k}|${key}`;
    if (awardRef.current[rk] || (((meta.awarded || {})[k]) || []).includes(key)) return false;
    awardRef.current[rk] = true;
    setMeta((m) => ({ ...m, awarded: { ...pruneDays(m.awarded, 14), [k]: [...(((m.awarded || {})[k]) || []), key] } }));
    setXp((x) => x + amt);
    bump(1);
    return true;
  };
  const flagTask = (id, key) => setTasks((p) => p.map((t) => (t.id === id ? { ...t, [key]: !t[key] } : t)));
  const routineSteps = (kind) => ((meta.routines || {})[kind]) || DEFAULT_ROUTINES[kind];
  const routineDone = (kind) => ((((meta.routines || {}).done || {})[dayKey(0)] || {})[kind]) || [];
  const routineToggle = (kind, id) => {
    const k = dayKey(0), cur = routineDone(kind), nx = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setMeta((m) => { const r = m.routines || {}, d = r.done || {}, day = d[k] || {}; return { ...m, routines: { ...r, done: { ...pruneDays(d), [k]: { ...day, [kind]: nx } } } }; });
    if (routineSteps(kind).every((x) => nx.includes(x.id))) award(`routine:${kind}`, 6);
  };
  const finishShutdown = ({ grat, ids, one }) => {
    const forKey = new Date().getHours() < 4 ? dayKey(0) : dayKey(1);
    setMeta((m) => ({ ...m, ivy: { for: forKey, ids, one }, shutdown: { ...pruneDays(m.shutdown, 60), [dayKey(0)]: true } }));
    if (grat) saveJournal(grat, 'Shutdown: one thing that went well today');
    award('shutdown', 10);
    showToast('Shutdown complete. Tomorrow is set up.');
  };
  const autoPlanNow = () => {
    const off = new Date().getHours() >= 21 ? 1 : 0, si = sleepInfo(meta);
    const pl = autoPlan({ nowH, off, wake: meta.wake, bed: si.bedTonight, pk, tasks: tasksRef.current, habits: habitsRef.current, due: cards.filter((c) => c.due <= dayKey(off)).length });
    if (!pl) { showToast('Not enough of the day is left to plan. Try again tomorrow morning.'); return; }
    applyPlan(pl, dayKey(off));
    showToast(off ? `Auto-plan saved for tomorrow (${pl.blocks.length} blocks)` : `Auto-plan applied: ${pl.blocks.length} blocks`);
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
    const pr = meta.principles || {}, rl = (pr.rules || []).slice(0, 4).map((x) => x.text).join('; '), idt = (pr.identity || []).slice(0, 3).map((x) => x.text).join('; ');
    if (rl) lines.push(`User's own rules: ${rl}.`);
    if (idt) lines.push(`Identity the user is building: ${idt}.`);
    const sk = (meta.skills || []).slice(0, 4).map((x) => `${x.name} ${Math.round(skillMins(x) / 60)}h of ${x.target}h`).join(', ');
    if (sk) lines.push(`Skills in practice: ${sk}.`);
    const pj = (meta.projects || []).filter((x) => x.steps.some((z) => !z.done)).slice(0, 3).map((x) => `${x.title} (next: ${x.steps.find((z) => !z.done).text})`).join('; ');
    if (pj) lines.push(`Active projects: ${pj}.`);
    const b3 = meta.big3 && meta.big3.wk === mondayKey(0) ? meta.big3.items.map((x) => `${x.text}${x.done ? ' (done)' : ''}`).join('; ') : '';
    if (b3) lines.push(`Weekly Big 3: ${b3}.`);
    const nut = meta.nut || {}, fd = (meta.food || []).filter((f) => keyOf(f.ts) === tk);
    if (fd.length) lines.push(`Nutrition today: ${sum(fd.map((f) => f.cal || 0))}/${nut.cal} kcal, ${sum(fd.map((f) => f.p || 0))}/${nut.p} g protein.`);
    const odp = (meta.people || []).filter((p) => dueIn(p) <= 0).slice(0, 3).map((p) => p.name).join(', ');
    if (odp) lines.push(`People overdue for contact: ${odp}.`);
    const wn = (meta.winsV || []).slice(0, 2).map((x) => x.text).join('; ');
    if (wn) lines.push(`Recent wins to remind the user of when they doubt themselves: ${wn}.`);
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

  const view = meta.lock && inPeak && !override && ['habits', 'coach', 'me', 'learn'].includes(tab) ? 'gate' : tab;
  const hl = SUB_IDS.includes(tab) ? (HOME[tab] || backTo) : tab;
  // Opening a tool remembers the feature you came from; hopping tool to tool keeps that origin
  const go = (id) => { if (SUB_IDS.includes(id)) setBackTo(SUB_IDS.includes(tab) ? backTo : tab); setTab(id); };
  const back = () => setTab(backTo);
  const openDraft = (text) => { setMode('all'); setCoachDraft({ text, n: Date.now() }); setTab('coach'); };
  const analyze = (t) => { setMode('all'); setTab('coach'); send(t); };
  const TABS = [{ id: 'today', icon: 'checkmark-circle', label: 'Today' }, { id: 'habits', icon: 'flame', label: 'Habits' }, { id: 'focus', icon: 'timer', label: 'Focus' }, { id: 'learn', icon: 'albums', label: 'Learn' }, { id: 'dump', icon: 'create', label: 'Dump' }, { id: 'stats', icon: 'stats-chart', label: 'Stats' }, { id: 'coach', icon: 'chatbubble-ellipses', label: 'Coach' }, { id: 'me', icon: 'person', label: 'Me' }];

  const ctx = {
    meta, setMeta, tasks, habits, cards, activity, xp, profile, memory, online, thinking, apiKey, pk, plan, tick, backTo, go, award, tool: tab,
    toast: showToast, analyze, draft: openDraft, setXp, bump, addTask, deleteTask, starTask, flagTask, toggleTask, addHabit, saveJournal,
    routineToggle, routineSteps, routineDone, finishShutdown, autoPlanNow, capture: () => setCapture(true),
  };

  return (
    <AppCtx.Provider value={ctx}>
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
        {!online && <View style={s.offlineBanner}><Text style={s.offlineText}>Offline Mode</Text></View>}

        <View style={s.header}>
          <Logo />
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {online && (
              <View style={[s.badge, winW < 440 && { paddingHorizontal: 8 }]}><View style={s.badgeDot} />{winW >= 440 && <Text style={s.badgeText}>Online</Text>}</View>
            )}
            <Pressable onPress={() => go('search')} style={[s.gear, { marginLeft: 6 }]} accessibilityLabel="Search"><Icon n="search-outline" size={22} color={C.muted} /></Pressable>
            <Pressable onPress={() => setShowSettings(true)} style={[s.gear, { marginLeft: 6 }]} accessibilityLabel="Settings"><Icon n="settings-outline" size={22} color={C.muted} /></Pressable>
          </View>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          {view === 'gate' && <Gate end={fmt(pk.end)} onFocus={() => setTab('focus')} onOverride={() => setShield('override')} />}
          {view === 'learn' && <Learn cards={cards} setCards={setCards} online={online} apiKey={apiKey} onOpenSettings={() => setShowSettings(true)} onReview={() => { lastQuiz.current = 0; maybeQuiz(); }} />}
          {view === 'dump' && <Dump meta={meta} onDump={dump} />}
          {view === 'stats' && <Stats tasks={tasks} habits={habits} activity={activity} cards={cards} meta={meta} setMeta={setMeta} online={online} onOpen={go} onAnalyze={analyze} />}
          {view === 'today' && (
            <Today name={(profile.name || '').trim()} tasks={tasks} habits={habits} xp={xp} online={online} busy={thinking} activity={activity} focusMin={focusMin}
              meta={meta} setMeta={setMeta} pk={pk} inPeak={inPeak} plan={plan} tomorrowPlan={tomorrowPlan} score={score} nudgeList={nudgeList}
              onOpen={go} onUrge={() => setShield('urge')} onToggle={toggleTask} onAdd={addTask} onDelete={deleteTask} onPlan={planNow}
              onStar={starTask} onRepeat={cycleRepeat} onClearDone={clearDone} onToggleBlock={toggleBlock} onClearPlan={clearPlan} onWater={changeWater} />
          )}
          {view === 'habits' && <Habits habits={habits} onToggle={toggleHabit} onAdd={addHabit} onDelete={deleteHabit} />}
          {view === 'focus' && <Focus onDone={finishFocus} suggest={nextBlock ? nextBlock.title : ''} log={focusLog} skills={meta.skills || []} />}
          {view === 'me' && <Me profile={profile} setProfile={setProfile} memory={memory} setMemory={setMemory} />}
          {view === 'coach' && (
            <Coach online={online} hasKey={!!apiKey} messages={messages} thinking={thinking} mode={mode} setMode={setMode}
              onSend={send} onOpenSettings={() => setShowSettings(true)} onClear={requestClear} acts={acts} draft={coachDraft} />
          )}
          {view === 'sleep' && <Sleep meta={meta} setMeta={setMeta} activity={activity} onBack={back} />}
          {view === 'journal' && <Journal meta={meta} setMeta={setMeta} onSave={saveJournal} onBack={back} />}
          {view === 'goals' && <Goals meta={meta} setMeta={setMeta} onXp={(d) => setXp((x) => Math.max(0, x + d))} onBack={back} />}
          {view === 'badges' && <Badges list={bdg} onBack={back} />}
          {view === 'review' && <Review habits={habits} activity={activity} meta={meta} online={online} onBack={back} onAnalyze={analyze} />}
          {SCREEN_MAP[view] ? React.createElement(SCREEN_MAP[view]) : null}
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
        <QuickCapture visible={capture} onClose={() => setCapture(false)} />
        {!['coach', 'focus', 'gate'].includes(view) && !capture && <Fab onPress={() => setCapture(true)} />}
        <Toast toast={toast} onUndo={() => { const f = toast && toast.undo; setToast(null); if (f) f(); }} onClose={() => setToast(null)} />
      </SafeAreaView>
    </SafeAreaProvider>
    </AppCtx.Provider>
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

  page: { width: '100%', maxWidth: MAX_W, alignSelf: 'center', padding: 20, paddingBottom: 96 },
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
  glass: { width: 18, height: 22, margin: 3, borderRadius: 5, borderWidth: 1.5, borderColor: C.disabled },
  applied: { marginTop: 6, backgroundColor: C.surface, borderWidth: 1, borderColor: '#14532D', borderRadius: 14, padding: 12 },
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C20', borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, width: '100%', maxWidth: 520, elevation: 8 },
  toastBtn: { color: '#60A5FA', fontWeight: '700', fontSize: 14, marginLeft: 12 },
  fab: { position: 'absolute', right: 18, width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
});
