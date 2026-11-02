import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ---------- Config ----------
   Free Gemini API key: https://aistudio.google.com/apikey
   If you get a "model not found" error, change MODEL. */
const MODEL = 'gemini-flash-latest';
const KEY_STORE = 'autokinetics:apikey';
const DATA_STORE = 'autokinetics:data';

const CATS = [
  { id: 'academics', name: 'Academics', icon: '📚', color: '#60A5FA', focus: 'study systems, learning, exams, reading, deep work' },
  { id: 'mind', name: 'Mind', icon: '🧠', color: '#C084FC', focus: 'focus, stress, journaling, sleep, emotional resilience' },
  { id: 'body', name: 'Body', icon: '💪', color: '#34D399', focus: 'training, nutrition, sleep, recovery, energy' },
  { id: 'discipline', name: 'Discipline', icon: '🎯', color: '#FBBF24', focus: 'routines, willpower, time management, consistency' },
  { id: 'career', name: 'Career', icon: '💼', color: '#FB923C', focus: 'skills, income, projects, networking, financial habits' },
  { id: 'social', name: 'Social', icon: '🤝', color: '#F472B6', focus: 'communication, relationships, leadership, confidence' },
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
const fmt = (h) => { const hh = Math.floor(h) % 24; return `${hh % 12 || 12}:${h % 1 ? '30' : '00'} ${hh < 12 ? 'AM' : 'PM'}`; };
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
  const sleep = (meta.sleep || {})[dayKey(0)] ?? 7, short = sleep < 6;
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

const buildSystem = (mode, tasks, habits, profile = {}, memory = []) => {
  const c = mode === 'all' ? null : catOf(mode);
  const open = tasks.filter((t) => !t.done).map((t) => `- [${t.cat}] ${t.title}`).join('\n') || '(none)';
  const hb = habits.map((h) => `- [${h.cat}] ${h.title} (streak ${streakOf(h.log)}, done today: ${h.log.includes(dayKey(0))})`).join('\n') || '(none)';
  const me = [['Name', profile.name], ['Situation', profile.situation], ['Goals', profile.goals], ['Weaknesses', profile.weaknesses], ['Strengths', profile.strengths], ['Routine and values', profile.routine]]
    .filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}: ${v.trim()}`).join('\n') || '(not filled in yet: gently ask the user to complete their profile)';
  return `You are AutoKinetics, an elite personal coach whose mission is to make the user a genius-level, superhuman performer: smarter, stronger, more disciplined and more successful across six pillars: ${CATS.map((x) => x.name).join(', ')}. Hold them to a superhuman standard with evidence-based methods (deliberate practice, spaced repetition, sleep, progressive overload, deep work) and give honest feedback, not flattery. ${c ? `Current focus: ${c.name} (${c.focus}).` : 'Balance all four pillars.'}
Be direct, motivating and practical, never preachy. Use short checklists and time-blocked plans. Ask at most 3 short questions when you need details. For health topics give general guidance and suggest a professional for medical concerns. Never invent facts about the user.
Date: ${new Date().toString()}
Open tasks:
${open}
Habits:
${hb}
USER PROFILE (permanent memory: always use it, never ask for it again):
${me}
MEMORY FACTS:
${memory.length ? memory.map((f) => `- ${f}`).join('\n') : '(none yet)'}
When you learn a new lasting fact about the user, end your reply with [[remember: short fact]] (one tag per fact, only if genuinely new).`;
};

async function askGemini(apiKey, history, system) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: history.slice(-30).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) throw new Error('Free limit reached. Wait a minute and try again.');
    if (res.status === 400 || res.status === 403) throw new Error('Google rejected the request. Check your API key in settings.');
    throw new Error(data?.error?.message || `Request failed (${res.status})`);
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('The model sent an empty reply. Try again.');
  return text;
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

/* ---------- Small components ---------- */
function CatChips({ value, onChange, withAll }) {
  const list = withAll ? [{ id: 'all', name: 'All', icon: '✨', color: C.text }, ...CATS] : CATS;
  return (
    <View style={s.chipRow}>
      {list.map((c) => {
        const on = value === c.id;
        return (
          <Pressable key={c.id} onPress={() => onChange(c.id)} style={[s.chip, on && { borderColor: c.color, backgroundColor: C.raised }]}>
            <Text style={[s.chipText, on && { color: c.color }]}>{c.icon} {c.name}</Text>
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

/* ---------- Today ---------- */
function Today({ tasks, habits, xp, online, activity, focusMin, meta, setMeta, pk, inPeak, onUrge, onToggle, onAdd, onDelete, onPlan }) {
  const [cat, setCat] = useState('all');
  const lvl = Math.floor(xp / 100) + 1, into = xp % 100;
  const rank = RANKS[Math.min(lvl - 1, RANKS.length - 1)];
  const today = dayKey(0);
  const shown = tasks.filter((t) => cat === 'all' || t.cat === cat).sort((a, b) => a.done - b.done);
  const pillars = CATS.map((c) => {
    const ts = tasks.filter((t) => t.cat === c.id), hs = habits.filter((h) => h.cat === c.id);
    return { c, total: ts.length + hs.length, done: ts.filter((t) => t.done).length + hs.filter((h) => h.log.includes(today)).length };
  });
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <PeakCard meta={meta} setMeta={setMeta} pk={pk} inPeak={inPeak} />
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
            <Text style={s.pillarIcon}>{c.icon}</Text>
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
        <Text style={s.planText}>🛑 Urge to scroll? Pause first ({meta.urges} resisted)</Text>
      </Pressable>
      <Pressable disabled={!online} onPress={onPlan} style={[s.planBtn, !online && { opacity: 0.4 }]}>
        <Text style={s.planText}>{online ? '🤖 Ask Coach to plan my day' : 'Coach planning needs a connection'}</Text>
      </Pressable>

      <Text style={s.section}>Tasks</Text>
      <CatChips value={cat} onChange={setCat} withAll />
      <AddRow placeholder={`Add a ${cat === 'all' ? 'Discipline' : catOf(cat).name} task`} onAdd={(t) => onAdd(t, cat === 'all' ? 'discipline' : cat)} />
      {shown.length === 0 && <Text style={s.empty}>Nothing here yet. Add one small task you can finish today.</Text>}
      {shown.map((t) => {
        const c = catOf(t.cat);
        return (
          <View key={t.id} style={s.item}>
            <Pressable onPress={() => onToggle(t.id)} style={[s.check, { borderColor: c.color }, t.done && { backgroundColor: c.color }]}>
              {t.done && <Text style={s.tick}>✓</Text>}
            </Pressable>
            <Text style={[s.itemText, t.done && s.done]}>{t.title}</Text>
            <Text style={s.itemIcon}>{c.icon}</Text>
            <Pressable onPress={() => onDelete(t.id)} hitSlop={10}><Text style={s.x}>✕</Text></Pressable>
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
              <Text style={s.habitTitle}>{c.icon} {h.title}</Text>
              <Pressable onPress={() => onDelete(h.id)} hitSlop={10}><Text style={s.x}>✕</Text></Pressable>
            </View>
            <View style={[s.between, { marginTop: 12 }]}>
              <View style={{ flexDirection: 'row' }}>
                {[6, 5, 4, 3, 2, 1, 0].map((i) => (
                  <View key={i} style={[s.dot, h.log.includes(dayKey(-i)) && { backgroundColor: c.color, borderColor: c.color }]} />
                ))}
                <Text style={[s.muted, { marginLeft: 8 }]}>🔥 {streakOf(h.log)} day streak</Text>
              </View>
              <Pressable onPress={() => onToggle(h.id)} style={[s.logBtn, doneToday && { backgroundColor: c.color, borderColor: c.color }]}>
                <Text style={[s.logText, doneToday && { color: '#000' }]}>{doneToday ? 'Done ✓' : 'Check in'}</Text>
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
          <Text style={s.bigIcon}>🛑</Text>
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
          <View style={s.between}><Text style={s.muted}>🃏 Quick recall</Text><Pressable onPress={onClose} hitSlop={10}><Text style={s.x}>✕</Text></Pressable></View>
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

function PeakCard({ meta, setMeta, pk, inPeak }) {
  const d = new Date(), now = d.getHours() + d.getMinutes() / 60;
  const mins = Math.round((pk.start - now) * 60);
  const status = inPeak ? 'You are in your peak. Heavy tasks only, no scrolling.'
    : mins > 0 ? `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m. Line up your hardest task.`
    : 'Window closed. Use the rest of the day for light tasks and admin.';
  const sleep = (meta.sleep || {})[dayKey(0)] ?? 7;
  const Row = ({ label, val, onPick }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
      <Text style={[s.muted, { width: 110 }]}>{label}</Text>
      {[5, 6, 7, 8, 9].map((v) => (
        <Pressable key={v} onPress={() => onPick(v)} style={[s.mini, val === v && { borderColor: C.accent, backgroundColor: C.raised }]}><Text style={s.chipText}>{v}</Text></Pressable>
      ))}
    </View>
  );
  return (
    <View style={[s.card, inPeak && { borderColor: C.accent }]}>
      <Text style={s.muted}>⚡ Peak cognitive window</Text>
      <Text style={s.h1}>{fmt(pk.start)} – {fmt(pk.end)}</Text>
      <Text style={[s.muted, { marginTop: 4 }]}>{status}</Text>
      <Row label="Sleep last night (h)" val={Math.round(sleep)} onPick={(v) => setMeta((m) => ({ ...m, sleep: { ...m.sleep, [dayKey(0)]: v } }))} />
      <Row label="Wake time (am)" val={meta.wake} onPick={(v) => setMeta((m) => ({ ...m, wake: v }))} />
      <Text style={[s.muted, { marginTop: 8, fontSize: 12 }]}>{pk.learned ? 'Learned from when you actually finish focus sessions.' : 'Estimated from wake time and sleep. Learns your real peak after 3 focus sessions.'}</Text>
      <Pressable onPress={() => setMeta((m) => ({ ...m, lock: !m.lock }))} style={[s.logBtn, { alignSelf: 'flex-start', marginTop: 10 }, meta.lock && { borderColor: C.accent }]}>
        <Text style={s.logText}>🔒 Peak Lock: {meta.lock ? 'ON' : 'OFF'}</Text>
      </Pressable>
    </View>
  );
}

function Gate({ end, onFocus, onOverride }) {
  return (
    <View style={s.gate}>
      <Text style={s.bigIcon}>🔒</Text>
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
          : m.recovery ? `Never miss twice: today only needs ${m.needed} of ${m.n} habits to protect your momentum. ${m.done >= m.needed ? 'Target met ✓' : `${m.done}/${m.needed} done.`}`
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
      const t = await askGemini(apiKey, [{ role: 'user', text: `Topic: ${topic.trim()}` }], 'Create 8 high-quality flashcards that build deep understanding of the topic. Reply with ONLY a JSON array like [{"q":"question","a":"short answer"}]. No markdown.');
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
          <Pressable onPress={() => setCards((cs) => cs.filter((x) => x.id !== c.id))} hitSlop={10}><Text style={[s.x, { marginLeft: 12 }]}>✕</Text></Pressable>
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
      {meta.models.slice(0, 15).map((m, i) => <View key={i} style={s.item}><Text style={s.itemText}>💡 {m}</Text></View>)}
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
      <Text style={s.habitTitle}>⚡ Reaction time</Text>
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
      <Text style={s.habitTitle}>🧠 Working memory (digit span) · best {best || 0}</Text>
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

function Stats({ tasks, habits, activity, cards, meta, setMeta, online, onAnalyze }) {
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
    const readiness = Math.round(100 * (0.4 * clamp((sl[today] ?? 7) / 8) + 0.3 * (vel / 100) + 0.3 * (mood ? (mood.e - 1) / 4 : 0.6)));
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
    };
  }, [tasks, habits, activity, cards, meta]);

  const mood = (meta.mood || {})[today] || { m: 3, e: 3 };
  const setMood = (key, v) => setMeta((mt) => ({ ...mt, mood: { ...mt.mood, [today]: { m: 3, e: 3, ...(mt.mood || {})[today], [key]: v } } }));
  const hrs = meta.hours || {}, mx = Math.max(1, ...Object.values(hrs));
  const delta = m.fPrev ? Math.round(((m.f7 - m.fPrev) / m.fPrev) * 100) : null;
  const summary = `Give me a performance review from my analytics. Cognitive index ${m.cpi}, readiness ${m.readiness}, focus last 7 days ${m.f7} min (previous week ${m.fPrev}), habit rate 7d ${m.h7}% and 30d ${m.h30}%, pillar balance ${m.balance}/100${m.weakest ? ` (weakest: ${m.weakest.name})` : ''}, recall retention ${m.ret ?? 'n/a'}%, impulse control ${m.ic ?? 'n/a'}%, average sleep ${m.avgSleep.toFixed(1)}h, reaction ${m.rtAvg ?? 'n/a'} ms, memory span ${meta.span || 'n/a'}. Name my 3 biggest bottlenecks and give one concrete experiment for each this week.`;

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
          {['😞', '😕', '😐', '🙂', '😄'].map((e, i) => (
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
        <Tile label="Reaction (last 5)" value={m.rtAvg ? `${m.rtAvg}ms` : '–'} sub="lower is faster" />
        <Tile label="Memory span" value={meta.span || '–'} sub="digits" />
        <Tile label="Pillar balance" value={m.balance} sub={m.weakest ? `weakest: ${m.weakest.name}` : 'no data yet'} />
      </View>

      <View style={s.card}>
        <Text style={s.habitTitle}>Sleep and performance</Text>
        <Text style={[s.muted, { marginTop: 6 }]}>
          {m.edge === null ? 'Log sleep on days you sleep under and over 7 hours (Today tab) to see how sleep changes your output.'
            : `On nights with 7+ hours you complete ${m.edge >= 0 ? m.edge.toFixed(1) : Math.abs(m.edge).toFixed(1)} ${m.edge >= 0 ? 'more' : 'fewer'} wins per day than on shorter nights.`}
        </Text>
      </View>

      <View style={s.card}>
        <Text style={s.habitTitle}>Effort by pillar (14 days)</Text>
        {m.eff.map(({ c, v }) => (
          <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <Text style={{ width: 28, fontSize: 16 }}>{c.icon}</Text>
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
        <Text style={s.addBtnText}>{online ? '🤖 AI performance review of my stats' : 'AI review needs a connection'}</Text>
      </Pressable>
    </ScrollView>
  );
}

/* ---------- Focus ---------- */
function Focus({ onDone }) {
  const [mins, setMins] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const endRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((endRef.current - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (running && left <= 0) {
      setRunning(false); onDone(mins); setLeft(mins * 60);
      setMsg(`Session complete. +15 XP for ${mins} focused minutes.`);
    }
  }, [left, running]);
  const pick = (m) => { if (!running) { setMins(m); setLeft(m * 60); setMsg(''); } };
  const toggle = () => {
    if (!running) { endRef.current = Date.now() + left * 1000; setMsg(''); }
    setRunning(!running);
  };
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Deep focus</Text>
      <Text style={[s.muted, { marginBottom: 16 }]}>Genius-level work needs uninterrupted attention. One task, phone away, nothing else open.</Text>
      <View style={s.chipRow}>
        {[15, 25, 45, 90].map((m) => (
          <Pressable key={m} onPress={() => pick(m)} style={[s.chip, mins === m && { borderColor: C.accent, backgroundColor: C.raised }]}>
            <Text style={s.chipText}>{m} min</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.timer}>{pad(Math.floor(left / 60))}:{pad(left % 60)}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <Pressable onPress={toggle} style={[s.addBtn, { paddingVertical: 14, paddingHorizontal: 32, marginLeft: 0 }]}>
          <Text style={s.addBtnText}>{running ? 'Pause' : 'Start focus'}</Text>
        </Pressable>
        <Pressable onPress={() => { setRunning(false); setLeft(mins * 60); }} style={[s.ghost, { marginLeft: 10, justifyContent: 'center' }]}>
          <Text style={s.ghostText}>Reset</Text>
        </Pressable>
      </View>
      {!!msg && <Text style={[s.empty, { color: C.online }]}>{msg}</Text>}
      <View style={[s.card, { marginTop: 28 }]}>
        <Text style={s.habitTitle}>Deep work rules</Text>
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
          <Text style={s.itemText}>🧩 {f}</Text>
          <Pressable onPress={() => setMemory((m) => m.filter((x) => x !== f))} hitSlop={10}><Text style={s.x}>✕</Text></Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/* ---------- Coach ---------- */
function Coach({ online, hasKey, messages, thinking, mode, setMode, onSend, onOpenSettings }) {
  const [input, setInput] = useState('');
  const listRef = useRef(null);
  const canSend = online && !thinking && input.trim().length > 0;
  const go = (t) => { onSend(t); setInput(''); };
  return (
    <View style={{ flex: 1 }}>
      <View style={s.coachModes}><CatChips value={mode} onChange={setMode} withAll /></View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const u = item.role === 'user';
          return (
            <View style={[s.row, { justifyContent: u ? 'flex-end' : 'flex-start' }]}>
              <View style={[s.bubble, u ? s.bubbleU : s.bubbleA, item.error && { borderColor: C.offline }]}>
                <Text style={[s.bubbleText, item.error && { color: '#F87171' }]}>{item.text}</Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={s.hero}>
            <Text style={s.heroTitle}>Become better, every day.</Text>
            <Text style={s.heroSub}>Your coach knows your tasks and habits. Pick a pillar above, then ask.</Text>
            {!hasKey && (
              <Pressable onPress={onOpenSettings} style={s.keyCta}><Text style={s.keyCtaText}>Add your free Gemini key to start</Text></Pressable>
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
            <Text style={[s.sendIcon, !canSend && { color: '#6B6B73' }]}>↑</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SettingsModal({ visible, apiKey, onSave, onClear, onClose }) {
  const [draft, setDraft] = useState(apiKey);
  useEffect(() => setDraft(apiKey), [apiKey, visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.modal}>
          <Text style={s.h1}>Settings</Text>
          <Text style={[s.muted, { marginTop: 16, marginBottom: 8 }]}>Gemini API key</Text>
          <TextInput style={s.keyInput} value={draft} onChangeText={setDraft} placeholder="Paste key from aistudio.google.com/apikey"
            placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry keyboardAppearance="dark" />
          <Text style={[s.muted, { marginTop: 12, fontSize: 13 }]}>
            Stored only on this device. Free-tier prompts may be used by Google to improve its products, so keep sensitive details out of chats.
          </Text>
          <View style={[s.between, { marginTop: 20 }]}>
            <Pressable style={s.ghost} onPress={onClear}><Text style={[s.ghostText, { color: '#F87171' }]}>Clear chat</Text></Pressable>
            <View style={{ flexDirection: 'row' }}>
              <Pressable style={s.ghost} onPress={onClose}><Text style={s.ghostText}>Close</Text></Pressable>
              <Pressable style={[s.ghost, { backgroundColor: C.accent, marginLeft: 8 }]} onPress={() => onSave(draft.trim())}>
                <Text style={[s.ghostText, { color: C.onAccent }]}>Save key</Text>
              </Pressable>
            </View>
          </View>
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
  const [meta, setMeta] = useState({ wake: 7, lock: false, sleep: {}, hours: {}, urges: 0, slips: 0, models: [], archive: [], focusDays: {}, reviews: { ok: 0, n: 0 }, mood: {}, rt: [], span: 0 });
  const [override, setOverride] = useState(false);
  const [shield, setShield] = useState(null);
  const [quizId, setQuizId] = useState(null);
  const [, setTick] = useState(0);
  const lastQuiz = useRef(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
  const pk = peakWindow(meta);
  const nd = new Date(), nowH = nd.getHours() + nd.getMinutes() / 60;
  const inPeak = nowH >= pk.start && nowH < pk.end;
  useEffect(() => { if (!inPeak) setOverride(false); }, [inPeak]);
  const [messages, setMessages] = useState([]);
  const [mode, setMode] = useState('all');
  const [thinking, setThinking] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [k, d] = await Promise.all([AsyncStorage.getItem(KEY_STORE), AsyncStorage.getItem(DATA_STORE)]);
        if (k) setApiKey(k);
        if (d) {
          const p = JSON.parse(d);
          setTasks(p.tasks || []); setHabits(p.habits || []); setXp(p.xp || 0); setMessages(p.messages || []);
          setProfile(p.profile || {}); setMemory(p.memory || []); setActivity(p.activity || {}); setFocusMin(p.focusMin || 0);
          setCards(p.cards || []); if (p.meta) setMeta((m) => ({ ...m, ...p.meta }));
        }
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => AsyncStorage.setItem(DATA_STORE, JSON.stringify({ tasks, habits, xp, profile, memory, activity, focusMin, cards, meta, messages: messages.slice(-60) })).catch(() => {}), 700);
    return () => clearTimeout(t);
  }, [tasks, habits, xp, profile, memory, activity, focusMin, cards, meta, messages, loaded]);

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
  const finishFocus = (m) => {
    const h = new Date(Date.now() - m * 60000).getHours();
    setXp((x) => x + 15); setFocusMin((f) => f + m); bump(1);
    setMeta((mt) => ({ ...mt, hours: { ...mt.hours, [h]: (mt.hours[h] || 0) + 1 }, focusDays: { ...mt.focusDays, [dayKey(0)]: ((mt.focusDays || {})[dayKey(0)] || 0) + m } }));
    setTimeout(maybeQuiz, 700);
  };
  const dump = (r) => {
    r.actions.forEach((t) => addTask(t, 'discipline'));
    setMeta((m) => ({ ...m, models: [...new Set([...r.models, ...m.models])].slice(0, 60), archive: [...r.archive, ...m.archive].slice(0, 100) }));
    bump(1);
  };
  const addTask = (title, cat) => setTasks((p) => [{ id: uid(), title, cat, done: false }, ...p]);
  const toggleTask = (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setXp((x) => Math.max(0, x + (t.done ? -10 : 10)));
    bump(t.done ? -1 : 1);
    if (!t.done) setTimeout(maybeQuiz, 700);
    setTasks((p) => p.map((x) => (x.id === id ? { ...x, done: !x.done } : x)));
  };
  const addHabit = (title, cat) => setHabits((p) => [...p, { id: uid(), title, cat, log: [] }]);
  const toggleHabit = (id) => {
    const h = habits.find((x) => x.id === id), today = dayKey(0);
    if (!h) return;
    const has = h.log.includes(today);
    setXp((x) => Math.max(0, x + (has ? -5 : 5)));
    bump(has ? -1 : 1);
    if (!has) setTimeout(maybeQuiz, 700);
    setHabits((p) => p.map((x) => (x.id === id ? { ...x, log: has ? x.log.filter((d) => d !== today) : [...x.log, today] } : x)));
  };

  const send = useCallback(async (raw) => {
    const text = raw.trim();
    if (!online || !text || thinking) return;
    if (!apiKey) { setShowSettings(true); return; }
    const u = { id: uid(), role: 'user', text };
    const history = [...messages.filter((m) => !m.error), u];
    setMessages((p) => [...p, u]); // instant user bubble
    setThinking(true);
    try {
      const reply = await askGemini(apiKey, history, buildSystem(mode, tasks, habits, profile, memory));
      const facts = [...reply.matchAll(/\[\[remember:\s*([\s\S]+?)\]\]/gi)].map((m) => m[1].trim());
      const clean = reply.replace(/\[\[remember:[\s\S]*?\]\]/gi, '').trim() || reply;
      if (facts.length) setMemory((m) => [...new Set([...m, ...facts])].slice(-40));
      setMessages((p) => [...p, { id: uid(), role: 'ai', text: clean }]);
    } catch (e) {
      setMessages((p) => [...p, { id: uid(), role: 'ai', text: e.message || 'Something went wrong.', error: true }]);
    } finally {
      setThinking(false);
    }
  }, [online, thinking, apiKey, messages, mode, tasks, habits, profile, memory]);

  const saveKey = async (k) => {
    setApiKey(k);
    try { await AsyncStorage.setItem(KEY_STORE, k); } catch (e) {}
    setShowSettings(false);
  };

  const view = meta.lock && inPeak && !override && ['habits', 'coach', 'me', 'learn'].includes(tab) ? 'gate' : tab;
  const TABS = [{ id: 'today', icon: '✅', label: 'Today' }, { id: 'habits', icon: '🔥', label: 'Habits' }, { id: 'focus', icon: '⏱', label: 'Focus' }, { id: 'learn', icon: '🃏', label: 'Learn' }, { id: 'dump', icon: '🌀', label: 'Dump' }, { id: 'stats', icon: '📊', label: 'Stats' }, { id: 'coach', icon: '🤖', label: 'Coach' }, { id: 'me', icon: '🧬', label: 'Me' }];

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <SafeAreaView style={s.safe} edges={['top', 'left', 'right', 'bottom']}>
        {!online && <View style={s.offlineBanner}><Text style={s.offlineText}>Offline Mode</Text></View>}

        <View style={s.header}>
          <Text style={s.brand}>AutoKinetics</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {online && (
              <View style={s.badge}><View style={s.badgeDot} /><Text style={s.badgeText}>Online</Text></View>
            )}
            <Pressable onPress={() => setShowSettings(true)} style={s.gear} accessibilityLabel="Settings"><Text style={s.gearText}>⚙</Text></Pressable>
          </View>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
          {view === 'gate' && <Gate end={fmt(pk.end)} onFocus={() => setTab('focus')} onOverride={() => setShield('override')} />}
          {view === 'learn' && <Learn cards={cards} setCards={setCards} online={online} apiKey={apiKey} onOpenSettings={() => setShowSettings(true)} onReview={() => { lastQuiz.current = 0; maybeQuiz(); }} />}
          {view === 'dump' && <Dump meta={meta} onDump={dump} />}
          {view === 'stats' && <Stats tasks={tasks} habits={habits} activity={activity} cards={cards} meta={meta} setMeta={setMeta} online={online}
            onAnalyze={(t) => { setMode('all'); setTab('coach'); send(t); }} />}
          {view === 'today' && (
            <Today tasks={tasks} habits={habits} xp={xp} online={online} activity={activity} focusMin={focusMin} meta={meta} setMeta={setMeta} pk={pk} inPeak={inPeak} onUrge={() => setShield('urge')} onToggle={toggleTask} onAdd={addTask}
              onDelete={(id) => setTasks((p) => p.filter((t) => t.id !== id))}
              onPlan={() => { setMode('all'); setTab('coach'); send('Build my plan for today using my open tasks and habits. Time-block it and tell me the one thing that matters most.'); }} />
          )}
          {view === 'habits' && (
            <Habits habits={habits} onToggle={toggleHabit} onAdd={addHabit} onDelete={(id) => setHabits((p) => p.filter((h) => h.id !== id))} />
          )}
          {view === 'focus' && <Focus onDone={finishFocus} />}
          {view === 'me' && <Me profile={profile} setProfile={setProfile} memory={memory} setMemory={setMemory} />}
          {view === 'coach' && (
            <Coach online={online} hasKey={!!apiKey} messages={messages} thinking={thinking} mode={mode} setMode={setMode}
              onSend={send} onOpenSettings={() => setShowSettings(true)} />
          )}
        </KeyboardAvoidingView>

        <View style={s.tabBar}>
          {TABS.map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={s.tab}>
              <Text style={[s.tabIcon, tab !== t.id && { opacity: 0.45 }]}>{t.icon}</Text>
              <Text style={[s.tabLabel, tab === t.id && { color: C.text }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        <Shield visible={!!shield} context={shield === 'override' ? 'You are about to break your Peak Lock.' : 'You feel an urge to escape the hard thing.'} onChoose={shieldChoose} />
        <MicroQuiz card={cards.find((c) => c.id === quizId)} onRate={rateCard} onClose={() => setQuizId(null)} />
        <SettingsModal visible={showSettings} apiKey={apiKey} onSave={saveKey}
          onClear={() => { setMessages([]); setShowSettings(false); }} onClose={() => setShowSettings(false)} />
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
});