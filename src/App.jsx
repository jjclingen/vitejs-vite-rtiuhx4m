import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  BookOpen, BarChart2, Settings, Plus, X, User, Lock,
  Search, Camera, Download, Trash2, Edit2, Droplets,
  Dumbbell, Star, Copy, ChevronDown, ChevronUp, Filter,
  Check, ArrowLeft, Users, Trophy, Utensils, Activity,
  Eye, EyeOff, ChevronLeft, ChevronRight, Flame, Scale,
  Pencil, FileText, AlertCircle, Apple, Heart, List,
  Calendar, RefreshCw, LogOut, Minus, Info, Zap,
  MessageSquare, Send, Globe, ExternalLink, Bot, ChefHat,
  Mail, Shield, UserPlus, LogIn, Link, Crown, UserMinus,
  Hash, DoorOpen
} from "lucide-react";

// ─────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail } from 'firebase/auth';
import {
  collection, doc, getDoc, getDocs,
  setDoc, deleteDoc, writeBatch, onSnapshot,
  query, where, updateDoc, arrayUnion, arrayRemove,
} from 'firebase/firestore';

// ─────────────────────────────────────────
// FIRESTORE DATA LAYER — GROUP-SCOPED
// ─────────────────────────────────────────
const COLLECTIONS = ['foodEntries','exerciseEntries','weightEntries',
  'waterEntries','customFoods','savedRecipes','favorites'];
const STATE_KEY = { profiles:'users' };

const generateInviteCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
};

// ─────────────────────────────────────────
// MIGRATION — flat v1 structure → group subcollections
// ─────────────────────────────────────────
const migrateFromOldStructure = async (authUser, groupName, onProgress) => {
  onProgress?.('Loading your existing data…');

  const [householdSnap, ...colSnaps] = await Promise.all([
    getDoc(doc(db, 'households', 'main')),
    ...COLLECTIONS.map(c => getDocs(collection(db, c))),
    getDocs(collection(db, 'profiles')),
  ]);

  const household = householdSnap.exists() ? householdSnap.data() : {};
  const [food, exercise, weight, water, custom, recipes, favs, profiles] =
    colSnaps.map(s => s.docs.map(d => ({ ...d.data(), id: d.id })));

  const groupId    = uid();
  const inviteCode = generateInviteCode();
  const memberUids = [...new Set([
    authUser.uid,
    ...profiles.map(p => p.id).filter(Boolean),
  ])];

  // ── Step 1: Create the group document FIRST (separate write) ─────────
  // Subcollection rules do get(/groups/{groupId}).data.members — the group
  // must exist in Firestore BEFORE the subcollection batches are committed.
  onProgress?.('Creating your new group…');
  await Promise.all([
    setDoc(doc(db, 'groups', groupId), {
      name:          groupName.trim() || 'My Household',
      inviteCode,
      admins:        [authUser.uid],
      members:       memberUids,
      adminPasscode: household.adminPasscode || null,
      anthropicKey:  household.anthropicKey  || '',
      createdAt:     new Date().toISOString(),
      createdBy:     authUser.uid,
    }),
    setDoc(doc(db, 'users', authUser.uid),
      { googleEmail: authUser.email, groups: [groupId] }, { merge: true }),
  ]);

  // ── Step 2: Batch-write all subcollection data ────────────────────────
  // Group exists now, so the member-check in subcollection rules will pass.
  const allColData = [food, exercise, weight, water, custom, recipes, favs];
  const ops = [];

  for (const p of profiles) {
    if (p.id) ops.push({ ref: doc(db, 'groups', groupId, 'profiles', p.id), data: p });
  }
  COLLECTIONS.forEach((colName, i) => {
    for (const item of (allColData[i] || [])) {
      if (item.id) ops.push({ ref: doc(db, 'groups', groupId, colName, item.id), data: item });
    }
  });

  const total = ops.length;
  onProgress?.(`Writing ${total} records…`);

  const BATCH_LIMIT = 450;
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_LIMIT).forEach(op => batch.set(op.ref, op.data));
    await batch.commit();
    if (ops.length > BATCH_LIMIT)
      onProgress?.(`Writing… ${Math.min(i + BATCH_LIMIT, total)} / ${total}`);
  }

  return groupId;
};

const loadFromFirestore = async (groupId) => {
  const gp = `groups/${groupId}`;
  const [groupSnap, ...colSnaps] = await Promise.all([
    getDoc(doc(db, 'groups', groupId)),
    ...COLLECTIONS.map(c => getDocs(collection(db, gp, c))),
    getDocs(collection(db, gp, 'profiles')),
  ]);
  const group = groupSnap.exists() ? groupSnap.data() : {};
  const [food,exercise,weight,water,custom,recipes,favs,profiles] =
    colSnaps.map(s => s.docs.map(d => ({...d.data(), id:d.id})));
  return {
    users: profiles,
    foodEntries: food, exerciseEntries: exercise,
    weightEntries: weight, waterEntries: water,
    customFoods: custom, savedRecipes: recipes, favorites: favs,
    adminPasscode: group.adminPasscode ?? null,
    anthropicKey:  group.anthropicKey  ?? '',
    groupName:     group.name          ?? '',
    groupAdmins:   group.admins        ?? [],
    groupMembers:  group.members       ?? [],
    inviteCode:    group.inviteCode    ?? '',
  };
};

const syncToFirestore = async (groupId, prev, next) => {
  if (!groupId) return;
  const batch = writeBatch(db);
  let ops = 0;
  const gp = `groups/${groupId}`;

  const syncCol = (prevArr=[], nextArr=[], colName) => {
    for (const item of nextArr) {
      const old = prevArr.find(p => p.id === item.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
        batch.set(doc(db, gp, colName, item.id), item); ops++;
      }
    }
    for (const item of prevArr) {
      if (!nextArr.find(n => n.id === item.id)) {
        batch.delete(doc(db, gp, colName, item.id)); ops++;
      }
    }
  };

  COLLECTIONS.forEach(c => syncCol(prev[STATE_KEY[c]||c], next[STATE_KEY[c]||c], c));
  syncCol(prev.users, next.users, 'profiles');

  const gFields = ['adminPasscode'];
  if (gFields.some(f => JSON.stringify(prev[f]) !== JSON.stringify(next[f]))) {
    const u = {}; gFields.forEach(f => { u[f] = next[f]; });
    batch.set(doc(db, 'groups', groupId), u, {merge:true}); ops++;
  }
  if (ops > 0) await batch.commit();
};

// ─────────────────────────────────────────
// CROSS-GROUP DIARY SYNC
// Personal diary (food/exercise/weight/water) belongs to the user, not the
// group. Any change is replicated to ALL groups the user is a member of so
// they never have to log the same thing twice.
// ─────────────────────────────────────────
const DIARY_KEYS = ['foodEntries','exerciseEntries','weightEntries','waterEntries'];

const crossSyncDiary = async (targetGroupIds, base, next, diaryKeys, userId) => {
  if (!targetGroupIds.length || !userId) return;
  for (const groupId of targetGroupIds) {
    const batch = writeBatch(db);
    let ops = 0;
    const gp = `groups/${groupId}`;
    for (const key of diaryKeys) {
      const prevArr = ((base || {})[key] || []).filter(e => e.userId === userId);
      const nextArr = ((next || {})[key] || []).filter(e => e.userId === userId);
      for (const item of nextArr) {
        const old = prevArr.find(p => p.id === item.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
          batch.set(doc(db, gp, key, item.id), item); ops++;
        }
      }
      for (const item of prevArr) {
        if (!nextArr.find(n => n.id === item.id)) {
          batch.delete(doc(db, gp, key, item.id)); ops++;
        }
      }
    }
    if (ops > 0) await batch.commit();
  }
};
// Replace the value below with your real key before deploying.
// ─────────────────────────────────────────
// API calls go through /api/ai (Netlify Function) — key is never in the browser
const AI_ENDPOINT = "/api/ai";

// ─────────────────────────────────────────
// AUTH SCREEN COMPONENTS
// ─────────────────────────────────────────
const LoginScreen = ({ onSignIn, onEmailSignIn, onEmailSignUp, onPasswordReset, error }) => {
  const [mode, setMode]             = useState('signin'); // 'signin' | 'signup' | 'reset'
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [confirm, setConfirm]       = useState('');
  const [localErr, setLocalErr]     = useState('');
  const [resetSent, setResetSent]   = useState(false);
  const [busy, setBusy]             = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const clearErr = () => { setLocalErr(''); };

  const handleSubmit = async () => {
    setLocalErr(''); setBusy(true);
    try {
      if (mode === 'reset') {
        await onPasswordReset(email);
        setResetSent(true);
      } else if (mode === 'signup') {
        if (password !== confirm) { setLocalErr("Passwords don't match."); return; }
        if (password.length < 6)  { setLocalErr("Password must be at least 6 characters."); return; }
        await onEmailSignUp(email, password);
      } else {
        await onEmailSignIn(email, password);
      }
    } catch(e) {
      const msgs = {
        'auth/user-not-found':      'No account with that email.',
        'auth/wrong-password':      'Incorrect password.',
        'auth/invalid-credential':  'Incorrect email or password.',
        'auth/email-already-in-use':'An account with that email already exists.',
        'auth/invalid-email':       'Please enter a valid email address.',
        'auth/too-many-requests':   'Too many attempts. Try again later.',
      };
      setLocalErr(msgs[e.code] || e.message || 'Something went wrong.');
    } finally { setBusy(false); }
  };

  const handleGoogle = async () => {
    setLocalErr(''); setGoogleBusy(true);
    try { await onSignIn(); }
    catch(e) {
      if (e.code === 'auth/popup-closed-by-user') { /* user cancelled, no message needed */ }
      else if (e.code === 'auth/popup-blocked')
        setLocalErr('Popup was blocked — please allow popups for this site and try again.');
      else if (e.code === 'auth/unauthorized-domain')
        setLocalErr('This preview URL isn\'t authorised in Firebase. Open the deployed Netlify app to use Google Sign-In, or add this domain in Firebase Console → Authentication → Settings → Authorized Domains.');
      else
        setLocalErr(`Google sign-in failed (${e.code || e.message})`);
    } finally { setGoogleBusy(false); }
  };

  const displayErr = localErr || error;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="text-center">
          <div className="w-20 h-20 rounded-3xl bg-emerald-500 flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/30">
            <Apple size={40} className="text-white"/>
          </div>
          <h1 className="text-3xl font-black text-white mt-4">NutriLog</h1>
          <p className="text-slate-400 mt-1">Your personal nutrition tracker</p>
        </div>

        {/* Mode tabs */}
        {mode !== 'reset' && (
          <div className="flex bg-slate-800 p-1 rounded-xl">
            <button onClick={()=>{setMode('signin');clearErr();setResetSent(false)}}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode==='signin'?'bg-emerald-500 text-white':'text-slate-400 hover:text-white'}`}>
              Sign In
            </button>
            <button onClick={()=>{setMode('signup');clearErr();setResetSent(false)}}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${mode==='signup'?'bg-emerald-500 text-white':'text-slate-400 hover:text-white'}`}>
              Create Account
            </button>
          </div>
        )}

        {/* Error */}
        {displayErr && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-center gap-2">
            <AlertCircle size={16} className="text-red-400 flex-shrink-0"/>
            <p className="text-red-300 text-sm">{displayErr}</p>
          </div>
        )}

        {/* Reset sent */}
        {resetSent && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-center">
            <p className="text-emerald-300 text-sm font-semibold">Reset email sent!</p>
            <p className="text-emerald-400/70 text-xs mt-1">Check your inbox and follow the link.</p>
          </div>
        )}

        {/* Form */}
        {!resetSent && (
          <div className="space-y-3">
            {mode === 'reset' && (
              <p className="text-slate-400 text-sm text-center">Enter your email and we'll send a reset link.</p>
            )}
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="Email address" onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            {mode !== 'reset' && (
              <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
                placeholder="Password" onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            )}
            {mode === 'signup' && (
              <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
                placeholder="Confirm password" onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            )}

            <button onClick={handleSubmit} disabled={busy || !email}
              className="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-white font-bold text-base transition-all active:scale-95">
              {busy ? 'Please wait…' : mode==='signin' ? 'Sign In' : mode==='signup' ? 'Create Account' : 'Send Reset Email'}
            </button>

            {mode === 'signin' && (
              <button onClick={()=>{setMode('reset');clearErr();setResetSent(false)}}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition-colors">
                Forgot password?
              </button>
            )}
            {mode === 'reset' && (
              <button onClick={()=>{setMode('signin');clearErr();setResetSent(false)}}
                className="w-full text-center text-sm text-slate-500 hover:text-slate-300 flex items-center justify-center gap-1 transition-colors">
                <ArrowLeft size={13}/> Back to sign in
              </button>
            )}
          </div>
        )}

        {/* Google — completely independent flow */}
        {mode !== 'reset' && !resetSent && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-700"/>
              <span className="text-xs text-slate-500">or</span>
              <div className="flex-1 h-px bg-slate-700"/>
            </div>
            <button onClick={handleGoogle} disabled={googleBusy}
              className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-50 text-gray-800 font-semibold px-6 py-3.5 rounded-2xl transition-all shadow-lg disabled:opacity-50 active:scale-95">
              {googleBusy
                ? <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin"/>
                : <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
              }
              {googleBusy ? 'Opening Google…' : 'Continue with Google'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// ── No group yet — create or join ─────────────────────────────────────
const NoGroupScreen = ({ onCreate, onJoin, onImport, hasOldData }) => (
  <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
    <div className="w-full max-w-sm text-center space-y-6">
      <div className="w-20 h-20 rounded-3xl bg-emerald-500 flex items-center justify-center mx-auto">
        <Apple size={40} className="text-white"/>
      </div>
      <div>
        <h1 className="text-3xl font-black text-white">NutriLog</h1>
        <p className="text-slate-400 mt-1">Get started by creating or joining a group</p>
      </div>
      <div className="space-y-3">
        {hasOldData && (
          <button onClick={onImport}
            className="w-full py-4 rounded-2xl border-2 border-violet-500/50 bg-violet-500/10 hover:bg-violet-500/20 text-white font-bold text-lg transition-all active:scale-95">
            <div className="flex items-center justify-center gap-2">
              <Download size={20} className="text-violet-400"/> Import Previous Data
            </div>
            <p className="text-xs font-normal text-violet-300/80 mt-0.5">We found your old NutriLog data — bring it in</p>
          </button>
        )}
        <button onClick={onCreate}
          className="w-full py-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-white font-bold text-lg transition-all active:scale-95">
          <div className="flex items-center justify-center gap-2"><Plus size={20}/> Create a Group</div>
          <p className="text-xs font-normal opacity-75 mt-0.5">Start fresh and invite others with a code</p>
        </button>
        <button onClick={onJoin}
          className="w-full py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-bold text-lg transition-all active:scale-95">
          <div className="flex items-center justify-center gap-2"><LogIn size={20}/> Join a Group</div>
          <p className="text-xs font-normal text-slate-400 mt-0.5">Enter an invite code from your group admin</p>
        </button>
      </div>
    </div>
  </div>
);

// ── Import / migrate existing data ────────────────────────────────────
const MigrateScreen = ({ authUser, onComplete, onBack }) => {
  const [groupName, setGroupName]   = useState('My Household');
  const [migrating, setMigrating]   = useState(false);
  const [progress, setProgress]     = useState('');
  const [err, setErr]               = useState('');

  const migrate = async () => {
    if (!groupName.trim()) return;
    setMigrating(true); setErr('');
    try {
      const groupId = await migrateFromOldStructure(authUser, groupName, setProgress);
      onComplete(groupId);
    } catch(e) {
      setErr(e.message || 'Migration failed — please try again.');
      setMigrating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <button onClick={onBack} disabled={migrating}
          className="text-slate-400 flex items-center gap-1 text-sm disabled:opacity-40">
          <ArrowLeft size={16}/> Back
        </button>
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-violet-500/20 flex items-center justify-center mx-auto mb-3">
            <Download size={26} className="text-violet-400"/>
          </div>
          <h2 className="text-2xl font-black text-white">Import Previous Data</h2>
          <p className="text-slate-400 text-sm mt-1">
            Everything from your old NutriLog will be moved into a new group.
          </p>
        </div>

        {/* What gets migrated */}
        <div className="bg-slate-800 rounded-2xl p-4 space-y-1.5">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">What gets imported</p>
          {[
            'All food diary entries',
            'Exercise & step logs',
            'Weight history',
            'Water logs',
            'User profiles & goals',
            'Custom foods & favourites',
            'Saved Gusteau recipes',
          ].map(item => (
            <div key={item} className="flex items-center gap-2">
              <Check size={13} className="text-emerald-400 flex-shrink-0"/>
              <span className="text-sm text-slate-300">{item}</span>
            </div>
          ))}
        </div>

        <div>
          <p className="text-sm font-semibold text-white mb-1">Group name</p>
          <input value={groupName} onChange={e=>setGroupName(e.target.value)}
            disabled={migrating}
            className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-60"/>
        </div>

        {migrating && (
          <div className="flex items-center gap-3 bg-violet-500/10 rounded-xl px-4 py-3">
            <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin flex-shrink-0"/>
            <p className="text-violet-300 text-sm">{progress || 'Working…'}</p>
          </div>
        )}

        {err && <p className="text-red-400 text-sm text-center">{err}</p>}

        <Btn onClick={migrate} disabled={!groupName.trim() || migrating} className="w-full" size="lg"
          style={{background: migrating ? undefined : 'linear-gradient(135deg,#7c3aed,#6d28d9)'}}>
          {migrating ? 'Importing…' : 'Import All Data'}
        </Btn>

        <p className="text-xs text-slate-500 text-center">
          Your original data stays untouched — this creates a copy in the new group format.
        </p>
      </div>
    </div>
  );
};

// ── Create a new group ────────────────────────────────────────────────
const CreateGroupScreen = ({ authUser, onComplete, onBack }) => {
  const [name, setName] = useState('');
  const [adminPass, setAdminPass] = useState('');
  const [adminPass2, setAdminPass2] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const valid = name.trim() && adminPass.length >= 4 && adminPass === adminPass2;

  const create = async () => {
    setSaving(true); setErr('');
    try {
      const groupId   = uid();
      const inviteCode = generateInviteCode();
      await setDoc(doc(db, 'groups', groupId), {
        name: name.trim(), inviteCode,
        admins: [authUser.uid], members: [authUser.uid],
        adminPasscode: adminPass, anthropicKey: '',
        createdAt: new Date().toISOString(), createdBy: authUser.uid,
      });
      await setDoc(doc(db, 'users', authUser.uid),
        { googleEmail: authUser.email, groups: arrayUnion(groupId) }, { merge:true });
      onComplete(groupId);
    } catch(e) { setErr(e.message || 'Failed to create group.'); setSaving(false); }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <button onClick={onBack} className="text-slate-400 flex items-center gap-1 text-sm"><ArrowLeft size={16}/> Back</button>
        <div className="text-center">
          <h2 className="text-2xl font-black text-white">Create a Group</h2>
          <p className="text-slate-400 text-sm mt-1">You'll be the admin. Others join with an invite code.</p>
        </div>
        <div>
          <p className="text-sm font-semibold text-white mb-1">Group name</p>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder='e.g. "The Smith Family"'
            className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
        </div>
        <div>
          <p className="text-sm font-semibold text-white mb-1">Admin passcode <span className="text-slate-500 font-normal text-xs">(min 4 digits — protects Settings)</span></p>
          <div className="space-y-2">
            <PasscodeInput value={adminPass} onChange={setAdminPass} placeholder="Choose passcode"/>
            <PasscodeInput value={adminPass2} onChange={v=>{setAdminPass2(v);setErr('');}} placeholder="Confirm passcode"/>
            {adminPass2 && adminPass!==adminPass2 && <p className="text-red-400 text-xs">Passcodes don't match</p>}
          </div>
        </div>
        {err && <p className="text-red-400 text-sm">{err}</p>}
        <Btn onClick={create} disabled={!valid||saving} className="w-full" size="lg">
          {saving ? 'Creating…' : 'Create Group'}
        </Btn>
      </div>
    </div>
  );
};

// ── Join an existing group ────────────────────────────────────────────
const JoinGroupScreen = ({ authUser, onComplete, onBack }) => {
  const [code, setCode]     = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState('');

  const join = async () => {
    setLoading(true); setErr('');
    try {
      const upper = code.trim().toUpperCase();
      const q = query(collection(db, 'groups'), where('inviteCode', '==', upper));
      const snap = await getDocs(q);
      if (snap.empty) { setErr('Invalid invite code — check with your group admin.'); setLoading(false); return; }
      const groupDoc = snap.docs[0];
      const groupId  = groupDoc.id;
      const gData    = groupDoc.data();
      if (!gData.members.includes(authUser.uid)) {
        await updateDoc(doc(db, 'groups', groupId), { members: arrayUnion(authUser.uid) });
      }
      await setDoc(doc(db, 'users', authUser.uid),
        { googleEmail: authUser.email, groups: arrayUnion(groupId) }, { merge:true });
      onComplete(groupId);
    } catch(e) { setErr(e.message || 'Failed to join. Try again.'); setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <button onClick={onBack} className="text-slate-400 flex items-center gap-1 text-sm"><ArrowLeft size={16}/> Back</button>
        <div className="text-center">
          <h2 className="text-2xl font-black text-white">Join a Group</h2>
          <p className="text-slate-400 text-sm mt-1">Enter the 6-character invite code from your admin.</p>
        </div>
        <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="e.g. FX7K9P"
          maxLength={6}
          className="w-full bg-slate-700 rounded-2xl px-4 py-4 text-white text-3xl font-black text-center tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
        {err && <p className="text-red-400 text-sm text-center">{err}</p>}
        <Btn onClick={join} disabled={code.length!==6||loading} className="w-full" size="lg">
          {loading ? 'Checking code…' : 'Join Group'}
        </Btn>
      </div>
    </div>
  );
};

// ── Group picker (multiple groups) ────────────────────────────────────
const GroupPickerScreen = ({ authUser, userGroups, onSelect, onCreateGroup, onJoinGroup }) => (
  <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6">
    <div className="w-full max-w-sm space-y-3">
      <div className="text-center mb-4">
        <h2 className="text-2xl font-black text-white">Your Groups</h2>
        <p className="text-slate-400 text-sm mt-1">Choose which group to open</p>
      </div>
      {userGroups.map(g => (
        <button key={g.id} onClick={()=>onSelect(g.id)}
          className="w-full flex items-center gap-3 bg-slate-800 hover:bg-slate-700 rounded-2xl px-4 py-3.5 text-left transition-all active:scale-95">
          <div className="w-11 h-11 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <Users size={20} className="text-emerald-400"/>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold truncate">{g.name}</p>
            <p className="text-xs text-slate-400">{g.members?.length||0} member{g.members?.length!==1?'s':''}</p>
          </div>
          {g.admins?.includes(authUser.uid) && (
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-semibold flex-shrink-0">Admin</span>
          )}
          <ChevronRight size={16} className="text-slate-500 flex-shrink-0"/>
        </button>
      ))}
      <div className="flex gap-2 pt-2">
        <button onClick={onCreateGroup}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-semibold border border-slate-700">
          <Plus size={15}/> New Group
        </button>
        <button onClick={onJoinGroup}
          className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-semibold border border-slate-700">
          <LogIn size={15}/> Join Group
        </button>
      </div>
    </div>
  </div>
);



// ─────────────────────────────────────────
// FOOD DATABASE
// ─────────────────────────────────────────
const FOOD_DB = [
  // Proteins
  { name:"Chicken Breast (grilled)", cal:165, p:31, c:0, f:3.6, sugar:0, sodium:74, fiber:0, serving:100, unit:"g" },
  { name:"Salmon (baked)", cal:208, p:20, c:0, f:13, sugar:0, sodium:59, fiber:0, serving:100, unit:"g" },
  { name:"Egg (boiled)", cal:78, p:6, c:0.6, f:5, sugar:0.6, sodium:62, fiber:0, serving:1, unit:"large" },
  { name:"Tuna (canned in water)", cal:116, p:25.5, c:0, f:0.8, sugar:0, sodium:340, fiber:0, serving:100, unit:"g" },
  { name:"Beef Mince (lean)", cal:215, p:26, c:0, f:12, sugar:0, sodium:78, fiber:0, serving:100, unit:"g" },
  { name:"Greek Yogurt (plain)", cal:59, p:10, c:3.6, f:0.4, sugar:3.2, sodium:36, fiber:0, serving:100, unit:"g" },
  { name:"Cottage Cheese", cal:98, p:11, c:3.4, f:4.3, sugar:3.4, sodium:364, fiber:0, serving:100, unit:"g" },
  { name:"Tofu (firm)", cal:76, p:8, c:2, f:4.2, sugar:0.5, sodium:7, fiber:0.3, serving:100, unit:"g" },
  { name:"Whey Protein Shake", cal:120, p:24, c:3, f:1.5, sugar:2, sodium:130, fiber:0, serving:1, unit:"scoop" },
  { name:"Turkey Breast", cal:135, p:30, c:0, f:1, sugar:0, sodium:70, fiber:0, serving:100, unit:"g" },
  { name:"Pork Chop", cal:242, p:26, c:0, f:14, sugar:0, sodium:62, fiber:0, serving:100, unit:"g" },
  { name:"Prawns / Shrimp", cal:99, p:24, c:0.2, f:0.3, sugar:0, sodium:111, fiber:0, serving:100, unit:"g" },
  // Grains
  { name:"White Rice (cooked)", cal:130, p:2.7, c:28, f:0.3, sugar:0, sodium:1, fiber:0.4, serving:100, unit:"g" },
  { name:"Brown Rice (cooked)", cal:112, p:2.6, c:23.5, f:0.9, sugar:0.4, sodium:5, fiber:1.8, serving:100, unit:"g" },
  { name:"Pasta (cooked)", cal:131, p:5, c:25, f:1.1, sugar:0.6, sodium:1, fiber:1.8, serving:100, unit:"g" },
  { name:"White Bread (1 slice)", cal:79, p:2.7, c:14.7, f:1, sugar:1.5, sodium:147, fiber:0.8, serving:1, unit:"slice" },
  { name:"Wholegrain Bread (1 slice)", cal:69, p:3.6, c:11.5, f:1, sugar:1.4, sodium:132, fiber:2, serving:1, unit:"slice" },
  { name:"Oats (dry)", cal:389, p:17, c:66, f:7, sugar:0, sodium:2, fiber:10.6, serving:100, unit:"g" },
  { name:"Sweet Potato (baked)", cal:90, p:2, c:20.7, f:0.1, sugar:4.2, sodium:36, fiber:3.3, serving:100, unit:"g" },
  { name:"Potato (boiled)", cal:87, p:1.9, c:20, f:0.1, sugar:0.9, sodium:6, fiber:1.8, serving:100, unit:"g" },
  { name:"Quinoa (cooked)", cal:120, p:4.4, c:21.3, f:1.9, sugar:0.9, sodium:7, fiber:2.8, serving:100, unit:"g" },
  { name:"Porridge with Milk", cal:110, p:4, c:18, f:2.5, sugar:5, sodium:55, fiber:1.5, serving:100, unit:"g" },
  // Vegetables
  { name:"Broccoli", cal:34, p:2.8, c:6.6, f:0.4, sugar:1.7, sodium:33, fiber:2.6, serving:100, unit:"g" },
  { name:"Spinach (raw)", cal:23, p:2.9, c:3.6, f:0.4, sugar:0.4, sodium:79, fiber:2.2, serving:100, unit:"g" },
  { name:"Carrot", cal:41, p:0.9, c:9.6, f:0.2, sugar:4.7, sodium:69, fiber:2.8, serving:100, unit:"g" },
  { name:"Mixed Salad Leaves", cal:15, p:1.2, c:2, f:0.3, sugar:1.5, sodium:28, fiber:1.3, serving:100, unit:"g" },
  { name:"Cucumber", cal:16, p:0.7, c:3.6, f:0.1, sugar:1.7, sodium:2, fiber:0.5, serving:100, unit:"g" },
  { name:"Tomato", cal:18, p:0.9, c:3.9, f:0.2, sugar:2.6, sodium:5, fiber:1.2, serving:100, unit:"g" },
  { name:"Bell Pepper", cal:31, p:1, c:6, f:0.3, sugar:4.2, sodium:4, fiber:2.1, serving:100, unit:"g" },
  { name:"Avocado", cal:160, p:2, c:9, f:15, sugar:0.7, sodium:7, fiber:7, serving:100, unit:"g" },
  { name:"Mushrooms", cal:22, p:3.1, c:3.3, f:0.3, sugar:2, sodium:5, fiber:1, serving:100, unit:"g" },
  { name:"Onion", cal:40, p:1.1, c:9.3, f:0.1, sugar:4.2, sodium:4, fiber:1.7, serving:100, unit:"g" },
  // Fruits
  { name:"Banana", cal:89, p:1.1, c:23, f:0.3, sugar:12, sodium:1, fiber:2.6, serving:1, unit:"medium" },
  { name:"Apple", cal:52, p:0.3, c:14, f:0.2, sugar:10, sodium:1, fiber:2.4, serving:1, unit:"medium" },
  { name:"Orange", cal:47, p:0.9, c:12, f:0.1, sugar:9.4, sodium:0, fiber:2.4, serving:1, unit:"medium" },
  { name:"Strawberries", cal:32, p:0.7, c:7.7, f:0.3, sugar:4.9, sodium:1, fiber:2, serving:100, unit:"g" },
  { name:"Blueberries", cal:57, p:0.7, c:14.5, f:0.3, sugar:9.9, sodium:1, fiber:2.4, serving:100, unit:"g" },
  { name:"Mango", cal:60, p:0.8, c:15, f:0.4, sugar:14, sodium:1, fiber:1.6, serving:100, unit:"g" },
  { name:"Grapes", cal:67, p:0.6, c:17, f:0.4, sugar:16, sodium:2, fiber:0.9, serving:100, unit:"g" },
  // Dairy
  { name:"Whole Milk", cal:61, p:3.2, c:4.8, f:3.3, sugar:5.1, sodium:43, fiber:0, serving:100, unit:"ml" },
  { name:"Skimmed Milk", cal:34, p:3.4, c:4.8, f:0.1, sugar:5, sodium:42, fiber:0, serving:100, unit:"ml" },
  { name:"Cheddar Cheese", cal:403, p:25, c:1.3, f:33, sugar:0.1, sodium:621, fiber:0, serving:100, unit:"g" },
  { name:"Butter", cal:717, p:0.9, c:0.1, f:81, sugar:0.1, sodium:714, fiber:0, serving:100, unit:"g" },
  { name:"Natural Yogurt", cal:61, p:5, c:7, f:1.5, sugar:7, sodium:46, fiber:0, serving:100, unit:"g" },
  // Snacks
  { name:"Almonds", cal:579, p:21, c:22, f:50, sugar:4.4, sodium:1, fiber:12.5, serving:100, unit:"g" },
  { name:"Peanut Butter", cal:588, p:25, c:20, f:50, sugar:9.1, sodium:430, fiber:6, serving:100, unit:"g" },
  { name:"Dark Chocolate (70%)", cal:598, p:7.8, c:46, f:43, sugar:24, sodium:20, fiber:10.9, serving:100, unit:"g" },
  { name:"Crisps", cal:536, p:7, c:53, f:35, sugar:0.5, sodium:531, fiber:4.8, serving:100, unit:"g" },
  { name:"Digestive Biscuit", cal:71, p:1, c:9.3, f:3, sugar:2.5, sodium:72, fiber:0.4, serving:1, unit:"biscuit" },
  { name:"Hummus", cal:166, p:8, c:14, f:10, sugar:0.5, sodium:379, fiber:6, serving:100, unit:"g" },
  { name:"Rice Cakes", cal:38, p:0.8, c:8.1, f:0.3, sugar:0.1, sodium:0.3, fiber:0.2, serving:1, unit:"cake" },
  // Drinks
  { name:"Orange Juice", cal:45, p:0.7, c:10.4, f:0.2, sugar:8.4, sodium:1, fiber:0.2, serving:100, unit:"ml" },
  { name:"Coffee (black)", cal:2, p:0.3, c:0, f:0, sugar:0, sodium:5, fiber:0, serving:240, unit:"ml" },
  { name:"Latte (whole milk)", cal:190, p:8, c:19, f:7, sugar:14, sodium:115, fiber:0, serving:355, unit:"ml" },
  { name:"Beer (regular)", cal:43, p:0.5, c:3.6, f:0, sugar:0, sodium:14, fiber:0, serving:100, unit:"ml" },
  { name:"Red Wine", cal:85, p:0.1, c:2.6, f:0, sugar:0.6, sodium:4, fiber:0, serving:100, unit:"ml" },
  { name:"Cola", cal:42, p:0, c:11, f:0, sugar:11, sodium:10, fiber:0, serving:100, unit:"ml" },
  { name:"Smoothie (fruit)", cal:60, p:1, c:14, f:0.5, sugar:11, sodium:10, fiber:1.5, serving:100, unit:"ml" },
  // Common meals
  { name:"Scrambled Eggs (2 eggs + butter)", cal:211, p:14, c:1.6, f:16, sugar:1.6, sodium:342, fiber:0, serving:1, unit:"serving" },
  { name:"Cheeseburger", cal:295, p:17, c:24, f:14, sugar:5, sodium:396, fiber:1, serving:1, unit:"burger" },
  { name:"Pizza (cheese, 1 slice)", cal:272, p:12, c:33, f:10, sugar:3.6, sodium:551, fiber:2.3, serving:1, unit:"slice" },
  { name:"Fish and Chips", cal:290, p:18, c:26, f:12, sugar:0.5, sodium:500, fiber:1.5, serving:100, unit:"g" },
  { name:"Caesar Salad", cal:181, p:7, c:10, f:13, sugar:2.5, sodium:398, fiber:2, serving:100, unit:"g" },
  { name:"Spaghetti Bolognese", cal:180, p:12, c:22, f:5, sugar:3, sodium:280, fiber:2, serving:100, unit:"g" },
];

const MEAL_CATEGORIES = [
  "Breakfast","Morning Snack","Lunch","Afternoon Snack",
  "Dinner","Evening Snack","Drinks/Alcohol"
];
const EXERCISE_TYPES = ["Cardio","Strength/Weights","Sport","Steps/Walking","Custom"];
const USER_COLORS = [
  "#6366f1","#ec4899","#f59e0b","#10b981",
  "#3b82f6","#ef4444","#8b5cf6","#14b8a6","#f97316","#84cc16"
];

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const r = (n, d=1) => Math.round(n * Math.pow(10,d)) / Math.pow(10,d);

const calcNutrition = (food, amount) => {
  const ratio = amount / food.serving;
  return {
    calories: Math.round(food.cal * ratio),
    protein: r(food.p * ratio),
    carbs: r(food.c * ratio),
    fat: r(food.f * ratio),
    sugar: r(food.sugar * ratio),
    sodium: Math.round(food.sodium * ratio),
    fiber: r(food.fiber * ratio),
  };
};

const fmtDate = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" });
};

const fmtDateShort = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-GB", { day:"numeric", month:"short" });
};

const getRangeForMode = (mode, cStart, cEnd) => {
  const td = todayStr();
  const d = new Date(td + "T00:00:00");
  if (mode === "day") return { start: td, end: td };
  if (mode === "week") {
    const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: mon.toISOString().slice(0,10), end: sun.toISOString().slice(0,10) };
  }
  if (mode === "month") {
    const lastDay = new Date(d.getFullYear(), d.getMonth()+1, 0);
    return { start: `${td.slice(0,7)}-01`, end: lastDay.toISOString().slice(0,10) };
  }
  if (mode === "custom") return { start: cStart||td, end: cEnd||td };
  return { start: td, end: td };
};

const getDatesInRange = (start, end) => {
  const dates = [], s = new Date(start+"T00:00:00"), e = new Date(end+"T00:00:00");
  for (let d = new Date(s); d <= e; d.setDate(d.getDate()+1))
    dates.push(d.toISOString().slice(0,10));
  return dates;
};

const initials = (name) => name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);

const getMealCurrentDefault = () => {
  const h = new Date().getHours();
  if (h < 10) return "Breakfast";
  if (h < 12) return "Morning Snack";
  if (h < 14) return "Lunch";
  if (h < 17) return "Afternoon Snack";
  if (h < 20) return "Dinner";
  return "Evening Snack";
};

// ─────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────
// LEGACY CONSTANTS (kept for default state shape)

const defaultState = {
  adminPasscode: null,
  users: [],
  foodEntries: [],
  exerciseEntries: [],
  weightEntries: [],
  waterEntries: [],
  customFoods: [],
  favorites: [],
  savedRecipes: [],
};

// ─────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────
const Avatar = ({ user, size=36, className="" }) => (
  <div className={`flex items-center justify-center rounded-full font-bold text-white select-none ${className}`}
    style={{ width:size, height:size, background:user.color, fontSize:size*0.35 }}>
    {initials(user.name)}
  </div>
);

const MacroPill = ({ label, value, color }) => (
  <div className="flex flex-col items-center">
    <span className="text-xs text-slate-400">{label}</span>
    <span className="text-sm font-semibold" style={{color}}>{value}g</span>
  </div>
);

const ProgressBar = ({ value, max, color="#10b981", label, sublabel }) => {
  const pct = max > 0 ? Math.min((value/max)*100, 100) : 0;
  return (
    <div className="mb-1">
      {(label||sublabel) && <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">{sublabel}</span>
      </div>}
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300" style={{width:`${pct}%`, background:color}} />
      </div>
    </div>
  );
};

const Btn = ({ onClick, children, variant="primary", className="", disabled=false, size="md" }) => {
  const base = "rounded-xl font-semibold transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50";
  const sizes = { sm:"px-3 py-1.5 text-xs", md:"px-4 py-2.5 text-sm", lg:"px-5 py-3 text-base" };
  const variants = {
    primary:"bg-emerald-500 text-white hover:bg-emerald-400",
    secondary:"bg-slate-700 text-white hover:bg-slate-600",
    danger:"bg-red-500/20 text-red-400 hover:bg-red-500/30",
    ghost:"text-slate-400 hover:text-white hover:bg-slate-700",
  };
  return <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>{children}</button>;
};

const Modal = ({ title, onClose, children, className="" }) => (
  <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={e=>e.target===e.currentTarget&&onClose()}>
    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
    <div className={`relative bg-slate-800 rounded-t-2xl w-full max-w-md max-h-[92vh] flex flex-col shadow-2xl ${className}`}>
      <div className="flex items-center justify-between p-4 border-b border-slate-700 flex-shrink-0">
        <h2 className="text-base font-bold text-white">{title}</h2>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-700 text-slate-400">
          <X size={18} />
        </button>
      </div>
      <div className="overflow-auto flex-1">{children}</div>
    </div>
  </div>
);

const PasscodeInput = ({ value, onChange, placeholder="Enter passcode" }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show?"text":"password"} value={value} onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 pr-12 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
      <button onClick={()=>setShow(s=>!s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
        {show ? <EyeOff size={18}/> : <Eye size={18}/>}
      </button>
    </div>
  );
};

// ─────────────────────────────────────────
// SETUP WIZARD
// ─────────────────────────────────────────
const SetupWizard = ({ onComplete, skipAdminPasscode = false }) => {
  const [step, setStep] = useState(skipAdminPasscode ? 1 : 0);
  const [adminPass, setAdminPass] = useState("");
  const [adminPass2, setAdminPass2] = useState("");
  const [userName, setUserName] = useState("");
  const [userColor, setUserColor] = useState(USER_COLORS[0]);
  const [userPass, setUserPass] = useState("");
  const [goals, setGoals] = useState({ calories:2000, protein:150, carbs:200, fat:65, water:64, steps:10000 });
  const [err, setErr] = useState("");

  const step0Valid = adminPass.length >= 4 && adminPass === adminPass2;
  const step1Valid = userName.trim().length >= 1;

  const finish = () => {
    const user = { id: uid(), name:userName.trim(), color:userColor,
      passcode:userPass||null, goals };
    if (skipAdminPasscode) onComplete(user);
    else onComplete({ adminPasscode:adminPass, users:[user] });
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-3">
            <Apple size={32} className="text-white"/>
          </div>
          <h1 className="text-2xl font-black text-white">NutriLog</h1>
          <p className="text-slate-400 text-sm mt-1">Multi-user calorie tracker</p>
        </div>

        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-white">Set admin passcode</h2>
            <p className="text-sm text-slate-400">This protects settings and all user data.</p>
            <PasscodeInput value={adminPass} onChange={setAdminPass} placeholder="Choose a passcode (min 4 digits)" />
            <PasscodeInput value={adminPass2} onChange={v=>{setAdminPass2(v);setErr("")}} placeholder="Confirm passcode" />
            {adminPass2 && adminPass !== adminPass2 && <p className="text-red-400 text-xs">Passcodes don't match</p>}
            <Btn onClick={()=>setStep(1)} disabled={!step0Valid} className="w-full" size="lg">
              Continue <ChevronRight size={16}/>
            </Btn>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <button onClick={()=>setStep(0)} className="text-slate-400 flex items-center gap-1 text-sm mb-2"><ArrowLeft size={16}/> Back</button>
            <h2 className="text-lg font-bold text-white">Add first user</h2>
            <input value={userName} onChange={e=>setUserName(e.target.value)} placeholder="Your name"
              className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            <div>
              <p className="text-sm text-slate-400 mb-2">Choose colour</p>
              <div className="flex gap-2 flex-wrap">
                {USER_COLORS.map(c=>(
                  <button key={c} onClick={()=>setUserColor(c)}
                    className="w-8 h-8 rounded-full border-2 transition-all"
                    style={{background:c, borderColor:userColor===c?"white":"transparent"}} />
                ))}
              </div>
            </div>
            <PasscodeInput value={userPass} onChange={setUserPass} placeholder="Personal passcode (optional)" />
            <div className="bg-slate-800 rounded-xl p-4 space-y-3">
              <p className="text-sm font-semibold text-slate-300">Daily goals</p>
              {[["Calories (kcal)","calories",500,5000],["Protein (g)","protein",0,400],
                ["Carbs (g)","carbs",0,600],["Fat (g)","fat",0,300],["Water (oz)","water",16,200]]
                .map(([lbl,key,min,max])=>(
                <div key={key}>
                  <div className="flex justify-between text-xs mb-1"><span className="text-slate-400">{lbl}</span><span className="text-white font-semibold">{goals[key]}</span></div>
                  <input type="range" min={min} max={max} step={key==="calories"?50:key==="water"?4:5}
                    value={goals[key]} onChange={e=>setGoals(g=>({...g,[key]:+e.target.value}))}
                    className="w-full accent-emerald-500" />
                </div>
              ))}
            </div>
            <Btn onClick={finish} disabled={!step1Valid} className="w-full" size="lg">
              Get started <Zap size={16}/>
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────
const BottomNav = ({ activeTab, setActiveTab }) => (
  <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-slate-900/95 backdrop-blur border-t border-slate-800 z-40">
    <div className="flex">
      {[["diary","Diary",BookOpen],["reports","Reports",BarChart2],["chat","Gusteau",ChefHat],["settings","Settings",Settings]].map(([id,label,Icon])=>(
        <button key={id} onClick={()=>setActiveTab(id)}
          className={`flex-1 flex flex-col items-center py-3 gap-0.5 transition-all
            ${activeTab===id
              ? id==="chat" ? "text-violet-400" : "text-emerald-400"
              : "text-slate-500 hover:text-slate-300"}`}>
          <Icon size={22}/>
          <span className="text-[10px] font-medium">{label}</span>
        </button>
      ))}
    </div>
  </div>
);

// ─────────────────────────────────────────
// DATE BAR
// ─────────────────────────────────────────
const DateBar = ({ dateMode, setDateMode, selectedDate, setSelectedDate, customStart, setCustomStart, customEnd, setCustomEnd }) => {
  const td = todayStr();
  const prevDay = () => {
    const d = new Date(selectedDate+"T00:00:00"); d.setDate(d.getDate()-1);
    setSelectedDate(d.toISOString().slice(0,10));
  };
  const nextDay = () => {
    const d = new Date(selectedDate+"T00:00:00"); d.setDate(d.getDate()+1);
    if (d.toISOString().slice(0,10) <= td) setSelectedDate(d.toISOString().slice(0,10));
  };

  return (
    <div className="bg-slate-800/50 px-4 py-3 space-y-3 border-b border-slate-700/50">
      <div className="flex gap-1">
        {["day","week","month","custom"].map(m=>(
          <button key={m} onClick={()=>setDateMode(m)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all
              ${dateMode===m?"bg-emerald-500 text-white":"bg-slate-700 text-slate-400 hover:bg-slate-600"}`}>
            {m}
          </button>
        ))}
      </div>
      {dateMode === "day" && (
        <div className="flex items-center justify-between">
          <button onClick={prevDay} className="p-1 rounded-lg hover:bg-slate-700 text-slate-400"><ChevronLeft size={18}/></button>
          <span className="text-sm font-semibold text-white">
            {selectedDate === td ? "Today" : fmtDate(selectedDate)}
          </span>
          <button onClick={nextDay} disabled={selectedDate>=td}
            className="p-1 rounded-lg hover:bg-slate-700 text-slate-400 disabled:opacity-30"><ChevronRight size={18}/></button>
        </div>
      )}
      {dateMode === "custom" && (
        <div className="flex gap-2">
          <div className="flex-1">
            <p className="text-xs text-slate-500 mb-1">From</p>
            <input type="date" value={customStart} max={td} onChange={e=>setCustomStart(e.target.value)}
              className="w-full bg-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
          </div>
          <div className="flex-1">
            <p className="text-xs text-slate-500 mb-1">To</p>
            <input type="date" value={customEnd} max={td} onChange={e=>setCustomEnd(e.target.value)}
              className="w-full bg-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────
// FOOD SEARCH — Open Food Facts
// Works in any real browser (StackBlitz, Netlify, etc.)
// ─────────────────────────────────────────
// ─────────────────────────────────────────
// FOOD SEARCH — Claude AI (primary) + Open Food Facts (barcode only)
// ─────────────────────────────────────────
const _foodCache = {};

const searchFoodWithAI = async (query) => {
  const key = query.toLowerCase().trim();
  if (_foodCache[key]) return _foodCache[key];

  // ── Primary: Anthropic API via server proxy — NO web search (avoids token blowout) ──
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system: "Return ONLY a JSON array, no other text.",
        messages: [{
          role: "user",
          content: `Nutrition for: "${query}"
Return ONLY JSON array (3-5 results):
[{"name":"name with brand/size","cal":0,"p":0,"c":0,"f":0,"sugar":0,"sodium":0,"fiber":0,"serving":100,"unit":"g"}]
cal=kcal, p/c/f/sugar/fiber=g, sodium=mg, all per serving.`,
        }],
      }),
    });

      if (!res.ok) throw new Error(`API ${res.status}`);
      const d = await res.json();
      const text = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.match(/\[[\s\S]*?\]/);
      if (match) {
        const results = JSON.parse(match[0]).filter(f => f.name && f.cal > 0);
        if (results.length) { _foodCache[key] = results; return results; }
      }
    } catch (e) {
      console.warn("Claude food search failed, falling back to Open Food Facts:", e.message);
    }

  // ── Fallback: Open Food Facts ──────────────────────────────────────
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&json=1&page_size=8&fields=product_name,brands,quantity,serving_size,nutriments`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Food database unavailable");
  const data = await res.json();
  const results = (data.products || []).filter(p => p.product_name).map(parseOFFProduct).filter(p => p.cal > 0);
  if (results.length) _foodCache[key] = results;
  return results;
};

const lookupBarcodeWithAI = async (barcode) => {
  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return parseOFFProduct(data.product);
};

// Open Food Facts helpers — used for barcode lookups only
const parseOFFServing = (raw = "") => {
  const parenMatch = raw.match(/\(\s*(\d+(?:\.\d+)?)\s*(g|ml|fl\.?\s*oz|oz)\s*\)/i);
  if (parenMatch) return { num: parseFloat(parenMatch[1]), unit: parenMatch[2].replace(/\s/g,'').toLowerCase() };
  const directMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(g|ml|fl\.?\s*oz|oz)\b/i);
  if (directMatch) return { num: parseFloat(directMatch[1]), unit: directMatch[2].replace(/\s/g,'').toLowerCase() };
  const num = parseFloat(raw);
  if (!isNaN(num) && num > 5) return { num, unit: raw.replace(/[\d.,\s]/g,"").trim().split(/\s/)[0]||"g" };
  return { num: 100, unit: "g" };
};

const parseOFFProduct = (p) => {
  const n = p.nutriments || {};
  const { num: servingNum, unit: servingUnit } = parseOFFServing(p.serving_size || "");
  const pick = (key) => {
    for (const s of [`${key}_serving`,`${key}s_serving`]) {
      const sv = n[s]; if (sv !== undefined && sv !== null && sv !== "" && !isNaN(parseFloat(sv))) return parseFloat(sv);
    }
    for (const s of [`${key}_100g`,`${key}s_100g`,`${key}_100ml`]) {
      const v = n[s]; if (v !== undefined && !isNaN(parseFloat(v))) return (parseFloat(v)*servingNum)/100;
    }
    return 0;
  };
  const kcal = pick("energy-kcal") || pick("energy")/4.184 || 0;
  const name = [p.brands, p.product_name, p.quantity].filter(Boolean).join(" — ").slice(0,70);
  return { name:name||"Unknown product", cal:Math.round(kcal), p:r(pick("proteins")), c:r(pick("carbohydrates")), f:r(pick("fat")), sugar:r(pick("sugars")), sodium:Math.round(pick("sodium")*1000), fiber:r(pick("fiber")), serving:servingNum, unit:servingUnit };
};
// ─────────────────────────────────────────
const AddFoodModal = ({ data, onClose, onAdd, defaultMeal, userId, onSaveCustomFood }) => {
  const [tab, setTab] = useState("search");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState("");
  const [meal, setMeal] = useState(defaultMeal || getMealCurrentDefault());

  // search state
  const [localResults, setLocalResults] = useState([]);
  const [webResults, setWebResults]   = useState([]);
  const [searching, setSearching]     = useState(false);
  const [searchErr, setSearchErr]     = useState("");
  const debounceRef = useRef(null);

  // barcode / camera
  const [barcodeMode, setBarcodeMode] = useState(false);
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeErr, setBarcodeErr] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const scanningRef = useRef(false);

  const allFoods = useMemo(() => [...FOOD_DB, ...data.customFoods], [data.customFoods]);
  const favorites = useMemo(() => data.favorites.filter(f => f.userId === userId), [data.favorites, userId]);

  // ── search logic ──────────────────────────────────────────
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setLocalResults(allFoods.slice(0, 20));
      setWebResults([]);
      setSearchErr("");
      return;
    }
    // instant local filter
    const ql = q.toLowerCase();
    setLocalResults(allFoods.filter(f => f.name.toLowerCase().includes(ql)));

    // Only search if query is at least 3 characters
    if (q.length < 3) { setSearching(false); setWebResults([]); return; }

    // debounced AI search — longer debounce reduces rapid-fire calls
    clearTimeout(debounceRef.current);
    setSearching(true);
    setSearchErr("");
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchFoodWithAI(q);
        setWebResults(results);
      } catch {
        setSearchErr("Food search unavailable. Please try again.");
      } finally {
        setSearching(false);
      }
    }, 1000);
  }, [query, allFoods]);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // ── barcode scanning ──────────────────────────────────────
  const startCamera = async () => {
    setBarcodeMode(true);
    setBarcodeErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }

      if ("BarcodeDetector" in window) {
        detectorRef.current = new window.BarcodeDetector({ formats: ["ean_13","ean_8","upc_a","upc_e","code_128","code_39"] });
        scanningRef.current = true;
        const scan = async () => {
          if (!scanningRef.current || !videoRef.current) return;
          try {
            const barcodes = await detectorRef.current.detect(videoRef.current);
            if (barcodes.length > 0) {
              scanningRef.current = false;
              stopCamera();
              await handleBarcodeScan(barcodes[0].rawValue);
              return;
            }
          } catch {}
          if (scanningRef.current) requestAnimationFrame(scan);
        };
        requestAnimationFrame(scan);
      }
    } catch {
      setBarcodeMode(false);
      setBarcodeErr("Camera access denied. Check browser permissions.");
    }
  };

  const stopCamera = () => {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach(t => t.stop());
    setBarcodeMode(false);
  };

  const handleBarcodeScan = async (barcode) => {
    setBarcodeLoading(true);
    setBarcodeErr("");
    try {
      const product = await lookupBarcodeWithAI(barcode);
      if (product) {
        setSelected(product);
        setAmount(String(product.serving));
        setTab("search");
      } else {
        setBarcodeErr(`Barcode ${barcode} not found.`);
      }
    } catch {
      setBarcodeErr("Barcode lookup failed. Try searching manually.");
    } finally {
      setBarcodeLoading(false);
    }
  };

  useEffect(() => () => { scanningRef.current = false; streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  // ── nutrition calc ─────────────────────────────────────────
  const nutrition = useMemo(() => {
    if (!selected || !amount || isNaN(+amount) || +amount <= 0) return null;
    return calcNutrition(selected, +amount);
  }, [selected, amount]);

  const handleAdd = () => {
    if (!selected || !nutrition) return;
    onAdd({ id: uid(), meal, foodName: selected.name, amount: +amount, unit: selected.unit, ...nutrition });
    onClose();
  };

  const selectFood = (food) => { setSelected(food); setAmount(String(food.serving)); };

  const handleFavAdd = (fav) => {
    setSelected({ name:fav.foodName, cal:fav.cal, p:fav.p, c:fav.c, f:fav.f,
      sugar:fav.sugar, sodium:fav.sodium, fiber:fav.fiber, serving:fav.serving, unit:fav.unit });
    setAmount(String(fav.amount));
    setTab("search");
  };

  // deduplicate web vs local by name
  const dedupedWeb = useMemo(() =>
    webResults.filter(w => !localResults.some(l => l.name.toLowerCase() === w.name.toLowerCase())),
    [webResults, localResults]
  );

  const FoodRow = ({ food, badge }) => (
    <button onClick={() => selectFood(food)}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-all flex items-start gap-3
        ${selected?.name === food.name
          ? "bg-emerald-500/20 border border-emerald-500/50"
          : "bg-slate-700/50 hover:bg-slate-700"}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm text-white leading-tight">{food.name}</p>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 flex items-center gap-1 flex-shrink-0">
              <Globe size={9}/>{badge}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-0.5">
          {food.cal} kcal · {food.serving}{food.unit}
          {food.p > 0 && ` · P:${food.p}g C:${food.c}g F:${food.f}g`}
        </p>
      </div>
      {selected?.name === food.name && <Check size={16} className="text-emerald-400 flex-shrink-0 mt-0.5"/>}
    </button>
  );

  return (
    <Modal title="Add Food" onClose={onClose}>
      <div className="p-4 space-y-4">
        {/* Meal */}
        <div>
          <p className="text-xs text-slate-400 mb-2">Meal</p>
          <div className="flex gap-1 flex-wrap">
            {MEAL_CATEGORIES.map(m => (
              <button key={m} onClick={() => setMeal(m)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all
                  ${meal===m ? "bg-emerald-500 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>{m}</button>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-700 p-1 rounded-xl">
          {[["search","Search"],["favorites","Favourites"],["custom","Custom"]].map(([id,lbl]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all
                ${tab===id ? "bg-slate-600 text-white" : "text-slate-400"}`}>{lbl}</button>
          ))}
        </div>

        {tab === "search" && (
          <>
            {/* Search input + camera */}
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                {searching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"/>
                )}
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder='Search any food — "grilled chicken", "Big Mac", "Greek yogurt"…'
                  className="w-full bg-slate-700 rounded-xl pl-9 pr-10 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
              </div>
              <button onClick={barcodeMode ? stopCamera : startCamera}
                className={`p-2.5 rounded-xl transition-all flex-shrink-0 ${barcodeMode ? "bg-emerald-500" : "bg-slate-700 hover:bg-slate-600"}`}>
                <Camera size={18} className="text-white"/>
              </button>
            </div>

            {/* Camera viewfinder */}
            {barcodeMode && (
              <div className="rounded-xl overflow-hidden bg-black aspect-video relative">
                <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover"/>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-56 h-28 border-2 border-emerald-400 rounded-lg opacity-80"/>
                </div>
                {"BarcodeDetector" in window ? (
                  <p className="absolute bottom-2 left-0 right-0 text-center text-xs text-emerald-300 bg-black/40 py-1">
                    📷 Scanning automatically…
                  </p>
                ) : (
                  <p className="absolute bottom-2 left-0 right-0 text-center text-xs text-yellow-300 bg-black/40 py-1">
                    Auto-scan not supported — enter barcode manually below
                  </p>
                )}
              </div>
            )}

            {/* Manual barcode entry if BarcodeDetector unavailable */}
            {barcodeMode && !("BarcodeDetector" in window) && (
              <div className="flex gap-2">
                <input id="manualBarcode" placeholder="Enter barcode number"
                  className="flex-1 bg-slate-700 rounded-xl px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
                <Btn size="sm" onClick={() => {
                  const v = document.getElementById("manualBarcode").value.trim();
                  if (v) { stopCamera(); handleBarcodeScan(v); }
                }}>Look up</Btn>
              </div>
            )}

            {barcodeLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-400 justify-center py-2">
                <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"/>
                Looking up barcode…
              </div>
            )}

            {(barcodeErr || searchErr) && (
              <p className="text-xs text-yellow-400 flex items-center gap-1">
                <AlertCircle size={12}/>{barcodeErr || searchErr}
              </p>
            )}

            {/* Results list */}
            <div className="space-y-1 max-h-56 overflow-auto">
              {/* Local results */}
              {localResults.length > 0 && (
                <>
                  {query.trim() && <p className="text-[10px] text-slate-500 uppercase tracking-wider px-1">Local library</p>}
                  {localResults.map((food, i) => <FoodRow key={`l-${i}`} food={food}/>)}
                </>
              )}
              {/* Claude AI results */}
              {dedupedWeb.length > 0 && (
                <>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider px-1 pt-1 flex items-center gap-1">
                    <Bot size={9}/> Claude AI
                  </p>
                  {dedupedWeb.map((food, i) => <FoodRow key={`w-${i}`} food={food} badge="Claude"/>)}
                </>
              )}
              {/* Empty states */}
              {!searching && query.trim() && localResults.length === 0 && dedupedWeb.length === 0 && (
                <div className="text-center py-6 text-slate-500 text-sm">
                  No results found — try a different search or add a custom food.
                </div>
              )}
              {!query.trim() && localResults.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-4">Start typing to search…</p>
              )}
            </div>
          </>
        )}

        {tab === "favorites" && (
          <div className="space-y-1 max-h-64 overflow-auto">
            {favorites.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">
                <Star size={24} className="mx-auto mb-2 opacity-30"/>
                No favourites yet — star a food entry to save it here.
              </div>
            )}
            {favorites.map(fav => (
              <div key={fav.id} className="flex items-center gap-2 bg-slate-700/50 rounded-xl px-3 py-2">
                <div className="flex-1">
                  <p className="text-sm text-white">{fav.foodName}</p>
                  <p className="text-xs text-slate-400">{fav.amount}{fav.unit} · {calcNutrition(fav, fav.amount).calories} kcal</p>
                </div>
                <Btn onClick={() => handleFavAdd(fav)} size="sm">Use</Btn>
              </div>
            ))}
          </div>
        )}

        {tab === "custom" && (
          <CustomFoodForm onAdd={(food) => {
            const withId = { ...food, id: uid() };
            // Persist to custom foods library so it appears in search later
            if (onSaveCustomFood) onSaveCustomFood(withId);
            setSelected(withId);
            setAmount(String(food.serving));
            setTab("search");
          }}/>
        )}

        {/* Selected food + amount */}
        {selected && (
          <div className="bg-slate-700/50 rounded-xl p-3 space-y-3 border border-slate-600">
            <p className="text-sm font-semibold text-white">{selected.name}</p>
            <div className="flex gap-2 items-center">
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
                className="w-24 bg-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="Amount"/>
              <span className="text-slate-400 text-sm">{selected.unit}</span>
            </div>
            {nutrition && (
              <div className="grid grid-cols-4 gap-2 text-center">
                {[["Cal",nutrition.calories,"#10b981"],["Pro",nutrition.protein+"g","#6366f1"],
                  ["Carb",nutrition.carbs+"g","#f59e0b"],["Fat",nutrition.fat+"g","#ec4899"]].map(([l,v,c]) => (
                  <div key={l} className="bg-slate-800 rounded-lg py-2">
                    <div className="text-xs text-slate-400">{l}</div>
                    <div className="text-sm font-bold" style={{color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            )}
            <Btn onClick={handleAdd} disabled={!nutrition} className="w-full">
              <Plus size={16}/> Add to diary
            </Btn>
          </div>
        )}
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────
// CUSTOM FOOD FORM
// ─────────────────────────────────────────
const CustomFoodForm = ({ onAdd }) => {
  const [form, setForm] = useState({ name:"",cal:0,p:0,c:0,f:0,sugar:0,sodium:0,fiber:0,serving:100,unit:"g" });
  const set = (k,v) => setForm(prev=>({...prev,[k]:v}));
  return (
    <div className="space-y-3">
      <input value={form.name} onChange={e=>set("name",e.target.value)} placeholder="Food name"
        className="w-full bg-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
      <div className="grid grid-cols-2 gap-2">
        {[["Serving size","serving"],["Unit","unit"],["Calories","cal"],["Protein (g)","p"],
          ["Carbs (g)","c"],["Fat (g)","f"],["Sugar (g)","sugar"],["Sodium (mg)","sodium"],["Fibre (g)","fiber"]]
          .map(([lbl,key])=>(
          <div key={key}>
            <p className="text-xs text-slate-400 mb-1">{lbl}</p>
            <input value={form[key]} onChange={e=>set(key,key==="unit"?e.target.value:+e.target.value)}
              type={key==="unit"?"text":"number"}
              className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
          </div>
        ))}
      </div>
      <Btn onClick={()=>onAdd(form)} disabled={!form.name.trim() || form.cal<=0} className="w-full" size="sm">
        Use this food
      </Btn>
    </div>
  );
};

// ─────────────────────────────────────────
// ADD EXERCISE MODAL
// ─────────────────────────────────────────
const AddExerciseModal = ({ onClose, onAdd }) => {
  const [type, setType] = useState("Cardio");
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [calories, setCalories] = useState("");
  const [notes, setNotes] = useState("");

  const handleAdd = () => {
    onAdd({ id:uid(), type, name:name||type, duration:+duration||0, caloriesBurned:+calories||0, notes });
    onClose();
  };

  return (
    <Modal title="Add Exercise" onClose={onClose}>
      <div className="p-4 space-y-4">
        <div>
          <p className="text-xs text-slate-400 mb-2">Type</p>
          <div className="flex gap-1 flex-wrap">
            {EXERCISE_TYPES.map(t=>(
              <button key={t} onClick={()=>setType(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${type===t?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>{t}</button>
            ))}
          </div>
        </div>
        {[["Name (optional)",name,setName,"text","e.g. 5km run"],
          ["Duration (minutes)",duration,setDuration,"number",""],
          ["Calories burned",calories,setCalories,"number",""],
          ["Notes",notes,setNotes,"text",""]].map(([lbl,val,setter,tp,ph])=>(
          <div key={lbl}>
            <p className="text-xs text-slate-400 mb-1">{lbl}</p>
            <input type={tp} value={val} onChange={e=>setter(e.target.value)} placeholder={ph}
              className="w-full bg-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
          </div>
        ))}
        <Btn onClick={handleAdd} disabled={!duration && !calories} className="w-full">
          <Plus size={16}/> Add exercise
        </Btn>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────
// ADD WEIGHT MODAL
// ─────────────────────────────────────────
const AddWeightModal = ({ onClose, onAdd, user }) => {
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState(user?.weightUnit||"lbs");
  return (
    <Modal title="Log Weight" onClose={onClose}>
      <div className="p-4 space-y-4">
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <p className="text-xs text-slate-400 mb-1">Weight</p>
            <input type="number" step="0.1" value={weight} onChange={e=>setWeight(e.target.value)}
              placeholder="0.0"
              className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white text-xl font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
          </div>
          <div className="flex gap-1 mb-0.5">
            {["kg","lbs"].map(u=>(
              <button key={u} onClick={()=>setUnit(u)}
                className={`px-3 py-3 rounded-xl text-sm font-semibold transition-all
                  ${unit===u?"bg-emerald-500 text-white":"bg-slate-700 text-slate-400 hover:bg-slate-600"}`}>{u}</button>
            ))}
          </div>
        </div>
        <Btn onClick={()=>{onAdd({id:uid(),weight:+weight,unit});onClose();}}
          disabled={!weight||+weight<=0} className="w-full">
          <Scale size={16}/> Save weight
        </Btn>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────
// ADD WATER MODAL
// ─────────────────────────────────────────
// ─────────────────────────────────────────
// ADD / EDIT STEPS MODAL
// Pre-fills with today's current total; saving replaces the day's entry
// ─────────────────────────────────────────
const STEP_PRESETS = [2500, 5000, 7500, 10000, 12500, 15000];

const AddStepsModal = ({ onClose, onSave, user, currentTotal }) => {
  const [steps, setSteps] = useState(currentTotal > 0 ? String(currentTotal) : "");
  const bio = user?.bio;
  const calc = useMemo(() => {
    const n = parseInt(steps);
    if (!n || n <= 0) return null;
    return calculateStepCalories(n, bio);
  }, [steps, bio]);

  const hasBio = bio?.currentWeight && bio?.heightFt;

  const handleSave = () => {
    const n = parseInt(steps);
    if (!n || n <= 0) return;
    const result = calc || { calories: Math.round(n * 0.04), distMi: 0, distKm: 0, durationMin: Math.round(n / 100) };
    onSave({
      id: uid(),
      type: "Steps/Walking",
      name: `${n.toLocaleString()} steps`,
      duration: result.durationMin,
      caloriesBurned: result.calories,
      steps: n,
      distanceMi: result.distMi,
      distanceKm: result.distKm,
      notes: "Auto-calculated from step count",
    });
    onClose();
  };

  return (
    <Modal title={currentTotal > 0 ? "Edit Today's Steps" : "Log Steps"} onClose={onClose}>
      <div className="p-4 space-y-4">
        {/* Big editable step count */}
        <div className="text-center">
          <input
            type="number"
            value={steps}
            onChange={e => setSteps(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); }}
            placeholder="0"
            autoFocus
            className="w-full bg-slate-700 rounded-2xl px-4 py-4 text-white text-4xl font-black text-center focus:outline-none focus:ring-2 focus:ring-orange-500 tracking-tight"
          />
          <p className="text-slate-500 text-xs mt-2">steps today</p>
        </div>

        {/* Presets */}
        <div className="grid grid-cols-3 gap-2">
          {STEP_PRESETS.map(p => (
            <button key={p} onClick={() => setSteps(String(p))}
              className={`py-2 rounded-xl text-sm font-bold transition-all
                ${steps === String(p) ? "bg-orange-500 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
              {p >= 1000 ? `${(p/1000).toFixed(1)}k` : p}
            </button>
          ))}
        </div>

        {/* Live calculation */}
        {calc && (
          <div className="bg-slate-700/50 rounded-2xl p-4 space-y-3">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-black text-orange-400">{calc.calories}</p>
                <p className="text-xs text-slate-400">kcal burned</p>
              </div>
              <div>
                <p className="text-2xl font-black text-blue-400">{calc.distMi}</p>
                <p className="text-xs text-slate-400">miles</p>
              </div>
              <div>
                <p className="text-2xl font-black text-emerald-400">{calc.durationMin}</p>
                <p className="text-xs text-slate-400">min est.</p>
              </div>
            </div>
            <p className="text-[11px] text-slate-500 text-center">
              {hasBio
                ? `Personalised for ${user.bio.heightFt}'${user.bio.heightIn || 0}" · ${user.bio.currentWeight} lbs · Firstbeat-style net active calories`
                : "Add height & weight in Settings for a personalised calculation"}
            </p>
          </div>
        )}

        {currentTotal > 0 && (
          <p className="text-xs text-slate-500 text-center">
            Replaces today's current total of {currentTotal.toLocaleString()} steps
          </p>
        )}

        <Btn onClick={handleSave} disabled={!steps || parseInt(steps) <= 0} className="w-full" size="lg">
          {currentTotal > 0 ? "Update Steps" : "Log Steps"}
        </Btn>
      </div>
    </Modal>
  );
};

const AddWaterModal = ({ onClose, onAdd }) => {
  const [amount, setAmount] = useState("");
  const presets = [8,12,16,20,24,32];
  return (
    <Modal title="Log Water" onClose={onClose}>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {presets.map(p=>(
            <button key={p} onClick={()=>setAmount(String(p))}
              className={`py-2.5 rounded-xl text-sm font-semibold transition-all
                ${amount===String(p)?"bg-blue-500 text-white":"bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
              {p}oz
            </button>
          ))}
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Or enter custom amount (oz)</p>
          <input type="number" value={amount} onChange={e=>setAmount(e.target.value)}
            placeholder="Amount in oz"
            className="w-full bg-slate-700 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        </div>
        <Btn onClick={()=>{onAdd({id:uid(),amount:+amount});onClose();}}
          disabled={!amount||+amount<=0} className="w-full"
          variant="primary">
          <Droplets size={16}/> Add water
        </Btn>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────
// USER SELECT MODAL
// ─────────────────────────────────────────
const UserSelectModal = ({ users, onSelect, onClose }) => {
  const [checkUser, setCheckUser] = useState(null);
  const [passcode, setPasscode] = useState("");
  const [err, setErr] = useState("");

  const trySelect = (user) => {
    if (!user.passcode) { onSelect(user); onClose(); return; }
    setCheckUser(user); setPasscode(""); setErr("");
  };
  const confirmPasscode = () => {
    if (passcode === checkUser.passcode) { onSelect(checkUser); onClose(); }
    else { setErr("Incorrect passcode"); setPasscode(""); }
  };

  if (checkUser) return (
    <Modal title={`Enter passcode for ${checkUser.name}`} onClose={()=>setCheckUser(null)}>
      <div className="p-4 space-y-4">
        <div className="flex justify-center mb-2"><Avatar user={checkUser} size={56}/></div>
        <PasscodeInput value={passcode} onChange={v=>{setPasscode(v);setErr("");}} placeholder="Enter passcode"/>
        {err && <p className="text-red-400 text-sm text-center">{err}</p>}
        <Btn onClick={confirmPasscode} disabled={!passcode} className="w-full">Confirm</Btn>
      </div>
    </Modal>
  );

  return (
    <Modal title="Who's logging?" onClose={onClose}>
      <div className="p-4 space-y-2">
        {users.map(user=>(
          <button key={user.id} onClick={()=>trySelect(user)}
            className="w-full flex items-center gap-3 bg-slate-700/50 hover:bg-slate-700 rounded-xl px-4 py-3 transition-all">
            <Avatar user={user} size={40}/>
            <div className="text-left flex-1">
              <p className="text-white font-semibold">{user.name}</p>
              {user.passcode && <p className="text-xs text-slate-400 flex items-center gap-1"><Lock size={10}/> Passcode protected</p>}
            </div>
            <ChevronRight size={18} className="text-slate-500"/>
          </button>
        ))}
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────
// INDIVIDUAL DIARY PAGE
// ─────────────────────────────────────────
const IndividualDiary = ({ data, updateData, activeUser, setActiveUser, selectedDate }) => {
  const [showModal, setShowModal]         = useState(null);
  const [addFoodMeal, setAddFoodMeal]     = useState(getMealCurrentDefault());
  const [showReevaluate, setShowReevaluate] = useState(false);
  const [movingEntryId, setMovingEntryId]   = useState(null);
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [editAmount, setEditAmount]         = useState("");
  const [showRecap, setShowRecap]           = useState(false);

  if (!activeUser) return (
    <div className="flex flex-col items-center justify-center py-20 px-4 text-center">
      <Users size={48} className="text-slate-600 mb-4"/>
      <p className="text-slate-300 font-semibold mb-1">Select a user</p>
      <p className="text-slate-500 text-sm mb-6">Choose who is logging today</p>
      <Btn onClick={()=>setShowModal("userSelect")} size="lg">
        <User size={16}/> Select user
      </Btn>
      {showModal==="userSelect" && (
        <UserSelectModal users={data.users} onSelect={setActiveUser} onClose={()=>setShowModal(null)}/>
      )}
    </div>
  );

  const user = data.users.find(u=>u.id===activeUser.id) || activeUser;
  const todayFood = data.foodEntries.filter(e=>e.userId===user.id && e.date===selectedDate);
  const todayExercise = data.exerciseEntries.filter(e=>e.userId===user.id && e.date===selectedDate);
  const todayWeight = data.weightEntries.filter(e=>e.userId===user.id && e.date===selectedDate);
  const todayWater = data.waterEntries.filter(e=>e.userId===user.id && e.date===selectedDate);

  const totalCalIn = todayFood.reduce((s,e)=>s+e.calories,0);
  const totalCalOut = todayExercise.reduce((s,e)=>s+e.caloriesBurned,0);
  const netCal = totalCalIn - totalCalOut;
  const totalWater = todayWater.reduce((s,e)=>s+e.amount,0);
  const totalProtein = todayFood.reduce((s,e)=>s+(e.protein||0),0);
  const totalCarbs = todayFood.reduce((s,e)=>s+(e.carbs||0),0);
  const totalFat = todayFood.reduce((s,e)=>s+(e.fat||0),0);

  // Steps: sum from exercise entries that have a steps field
  const todayStepEntries = todayExercise.filter(e => e.steps > 0);
  const totalSteps = todayStepEntries.reduce((s,e) => s + (e.steps||0), 0);
  const stepGoal = user.goals?.steps || 10000;

  const addFood = (entry) => {
    updateData({ foodEntries: [...data.foodEntries, { ...entry, userId:user.id, date:selectedDate }] });
  };
  const removeFood = (id) => updateData({ foodEntries: data.foodEntries.filter(e=>e.id!==id) });
  const moveFood = (id, newMeal) => {
    updateData({ foodEntries: data.foodEntries.map(e => e.id===id ? {...e, meal:newMeal} : e) });
    setMovingEntryId(null);
  };

  const editFood = (entry, newAmount) => {
    const amt = parseFloat(newAmount);
    if (!amt || amt <= 0) return;
    const ratio = amt / entry.amount;
    updateData({
      foodEntries: data.foodEntries.map(e => e.id === entry.id ? {
        ...e,
        amount:   amt,
        calories: Math.round(e.calories * ratio),
        protein:  r(e.protein  * ratio),
        carbs:    r(e.carbs    * ratio),
        fat:      r(e.fat      * ratio),
        sugar:    r(e.sugar    * ratio),
        sodium:   Math.round(e.sodium * ratio),
        fiber:    r(e.fiber    * ratio),
      } : e)
    });
    setEditingEntryId(null);
  };
  const toggleFavorite = (entry) => {
    const exists = data.favorites.find(f => f.userId === user.id && f.foodName === entry.foodName);
    if (exists) {
      updateData({ favorites: data.favorites.filter(f => f.id !== exists.id) });
    } else {
      // Build from entry directly — works for any food source (DB, AI search, barcode, custom)
      // Store serving = entry.amount so calcNutrition scales correctly when re-used
      updateData({ favorites: [...data.favorites, {
        id:      uid(),
        userId:  user.id,
        foodName: entry.foodName,
        amount:  entry.amount,
        unit:    entry.unit,
        cal:     entry.calories,
        p:       entry.protein  || 0,
        c:       entry.carbs    || 0,
        f:       entry.fat      || 0,
        sugar:   entry.sugar    || 0,
        sodium:  entry.sodium   || 0,
        fiber:   entry.fiber    || 0,
        serving: entry.amount,
      }]});
    }
  };

  const addExercise = (entry) => updateData({ exerciseEntries: [...data.exerciseEntries, {...entry, userId:user.id, date:selectedDate}] });
  const addSteps = (entry) => updateData({ exerciseEntries: [...data.exerciseEntries, {...entry, userId:user.id, date:selectedDate}] });
  const saveSteps = (entry) => {
    // Remove existing step entries for this day then add the new single total
    const withoutSteps = data.exerciseEntries.filter(
      e => !(e.userId === user.id && e.date === selectedDate && e.steps > 0)
    );
    updateData({ exerciseEntries: [...withoutSteps, {...entry, userId:user.id, date:selectedDate}] });
  };
  const removeExercise = (id) => updateData({ exerciseEntries: data.exerciseEntries.filter(e=>e.id!==id) });
  const addWeight = (entry) => {
    const filtered = data.weightEntries.filter(e=>!(e.userId===user.id && e.date===selectedDate));
    updateData({ weightEntries: [...filtered, {...entry, userId:user.id, date:selectedDate}] });
  };
  const addWater = (entry) => updateData({ waterEntries: [...data.waterEntries, {...entry, userId:user.id, date:selectedDate}] });
  const removeWater = (id) => updateData({ waterEntries: data.waterEntries.filter(e=>e.id!==id) });

  const copyPreviousDay = () => {
    const prev = new Date(selectedDate+"T00:00:00"); prev.setDate(prev.getDate()-1);
    const prevDate = prev.toISOString().slice(0,10);
    const prevFood = data.foodEntries.filter(e=>e.userId===user.id && e.date===prevDate);
    if (prevFood.length === 0) { alert("No entries found for yesterday."); return; }
    const copied = prevFood.map(e=>({...e, id:uid(), date:selectedDate}));
    updateData({ foodEntries: [...data.foodEntries, ...copied] });
  };

  const calorieGoal = user.goals?.calories || 2000;
  const waterGoal = user.goals?.water || 64;
  const pctCal = Math.min((totalCalIn/calorieGoal)*100,100);
  const remaining = calorieGoal - netCal;

  return (
    <div className="pb-4">
      {/* User header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800/40">
        <div className="flex items-center gap-3">
          <Avatar user={user} size={40}/>
          <div>
            <p className="text-white font-bold">{user.name}</p>
            <p className="text-xs text-slate-400">{selectedDate === todayStr() ? "Today" : fmtDate(selectedDate)}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={copyPreviousDay} className="p-2 rounded-lg hover:bg-slate-700 text-slate-400" title="Copy previous day">
            <Copy size={16}/>
          </button>
          {user.bio?.dob && (
            <button onClick={()=>setShowReevaluate(true)} className="p-2 rounded-lg hover:bg-slate-700 text-slate-400" title="Reevaluate my plan">
              <RefreshCw size={16}/>
            </button>
          )}
          <button onClick={()=>setActiveUser(null)} className="p-2 rounded-lg hover:bg-slate-700 text-slate-400" title="Switch user">
            <LogOut size={16}/>
          </button>
        </div>
      </div>

      {/* Calorie summary ring */}
      <div className="mx-4 mt-4 bg-slate-800 rounded-2xl p-4">
        <div className="flex items-center gap-4">
          {/* SVG ring */}
          <div className="relative w-24 h-24 flex-shrink-0">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="40" fill="none" stroke="#1e293b" strokeWidth="10"/>
              <circle cx="48" cy="48" r="40" fill="none" stroke={pctCal>=100?"#ef4444":"#10b981"} strokeWidth="10"
                strokeDasharray={`${2*Math.PI*40}`} strokeDashoffset={`${2*Math.PI*40*(1-pctCal/100)}`}
                strokeLinecap="round" style={{transition:"stroke-dashoffset 0.5s ease"}}/>
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-black text-white leading-none">{totalCalIn}</span>
              <span className="text-[10px] text-slate-400">kcal</span>
            </div>
          </div>
          {/* Stats */}
          <div className="flex-1 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Goal</span><span className="text-white font-semibold">{calorieGoal} kcal</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Exercise</span><span className="text-emerald-400 font-semibold">-{totalCalOut} kcal</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Remaining</span>
              <span className={`font-bold ${remaining<0?"text-red-400":"text-white"}`}>{remaining} kcal</span>
            </div>
          </div>
        </div>

        {/* Macros */}
        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-slate-700">
          {[["Protein",totalProtein,user.goals?.protein||150,"#6366f1"],
            ["Carbs",totalCarbs,user.goals?.carbs||200,"#f59e0b"],
            ["Fat",totalFat,user.goals?.fat||65,"#ec4899"]].map(([lbl,val,goal,col])=>(
            <div key={lbl} className="text-center">
              <div className="text-xs text-slate-400 mb-1">{lbl}</div>
              <div className="text-sm font-bold" style={{color:col}}>{r(val)}g</div>
              <div className="text-[10px] text-slate-500">/{goal}g</div>
              <div className="mt-1 h-1 bg-slate-700 rounded-full">
                <div className="h-full rounded-full" style={{width:`${Math.min((val/goal)*100,100)}%`,background:col}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Water */}
        <div className="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Droplets size={16} className="text-blue-400"/>
            <span className="text-sm text-slate-300">Water</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-32 h-2 bg-slate-700 rounded-full">
              <div className="h-full bg-blue-400 rounded-full" style={{width:`${Math.min((totalWater/waterGoal)*100,100)}%`}}/>
            </div>
            <span className="text-sm font-semibold text-white">{totalWater}/{waterGoal}oz</span>
            <button onClick={()=>setShowModal("addWater")} className="p-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30">
              <Plus size={14}/>
            </button>
          </div>
        </div>
        {todayWater.length > 0 && (
          <div className="mt-2 flex gap-1 flex-wrap">
            {todayWater.map(w=>(
              <div key={w.id} className="flex items-center gap-1 bg-blue-500/10 rounded-lg px-2 py-1 text-xs text-blue-300">
                <Droplets size={10}/>{w.amount}oz
                <button onClick={()=>removeWater(w.id)} className="text-blue-400/50 hover:text-blue-400 ml-1"><X size={10}/></button>
              </div>
            ))}
          </div>
        )}

        {/* Steps */}
        <div className="mt-3 pt-3 border-t border-slate-700">
          <button
            onClick={() => setShowModal("addSteps")}
            className="w-full flex items-center justify-between hover:bg-slate-700/30 rounded-xl px-1 py-1 -mx-1 transition-colors group">
            <div className="flex items-center gap-2">
              <span className="text-base leading-none">👟</span>
              <span className="text-sm text-slate-300">Steps</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-28 h-2 bg-slate-700 rounded-full">
                <div className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min((totalSteps / stepGoal) * 100, 100)}%`,
                    background: totalSteps >= stepGoal ? "#10b981" : "#f97316"
                  }}/>
              </div>
              <span className={`text-sm font-bold ${totalSteps >= stepGoal ? "text-emerald-400" : "text-white"}`}>
                {totalSteps > 0 ? totalSteps.toLocaleString() : "—"}
              </span>
              <span className="text-xs text-slate-500">/{stepGoal.toLocaleString()}</span>
              <Pencil size={13} className="text-slate-600 group-hover:text-orange-400 transition-colors"/>
            </div>
          </button>
          {totalSteps > 0 && (() => {
            const calc = calculateStepCalories(totalSteps, user.bio);
            return (
              <div className="flex gap-3 mt-1.5 px-1 text-xs text-slate-500">
                {calc && <><span className="text-orange-400">-{calc.calories} kcal</span><span>·</span><span>{calc.distMi} mi</span><span>·</span><span>~{calc.durationMin} min</span></>}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Food log by meal */}
      <div className="px-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">Food</h3>
          <Btn onClick={()=>{setAddFoodMeal(getMealCurrentDefault());setShowModal("addFood");}} size="sm">
            <Plus size={14}/> Add food
          </Btn>
        </div>
        {MEAL_CATEGORIES.map(meal=>{
          const entries = todayFood.filter(e=>e.meal===meal);
          if (entries.length===0) return null;
          const mealCal = entries.reduce((s,e)=>s+e.calories,0);
          return (
            <div key={meal} className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-4 rounded-full" style={{background:user.color}}/>
                  <span className="text-sm font-semibold text-slate-300">{meal}</span>
                </div>
                <span className="text-xs text-slate-500">{mealCal} kcal</span>
              </div>
              <div className="space-y-1">
                {entries.map(entry=>{
                  const isFav    = data.favorites.some(f=>f.userId===user.id && f.foodName===entry.foodName);
                  const isMoving = movingEntryId  === entry.id;
                  const isEditing = editingEntryId === entry.id;

                  // Live preview while editing
                  const previewAmt = parseFloat(editAmount);
                  const previewRatio = (isEditing && previewAmt > 0) ? previewAmt / entry.amount : 1;
                  const previewCal = Math.round(entry.calories * previewRatio);

                  return (
                    <div key={entry.id} className="bg-slate-800 rounded-xl overflow-hidden">
                      {/* Main row */}
                      <div className="px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{entry.foodName}</p>
                          <p className="text-xs text-slate-500">{entry.amount}{entry.unit} · P:{r(entry.protein)}g C:{r(entry.carbs)}g F:{r(entry.fat)}g</p>
                        </div>
                        <span className="text-sm font-bold text-white flex-shrink-0">{entry.calories}</span>
                        {/* Edit */}
                        <button onClick={()=>{
                            if (isEditing) { setEditingEntryId(null); }
                            else { setEditingEntryId(entry.id); setEditAmount(String(entry.amount)); setMovingEntryId(null); }
                          }}
                          title="Edit amount"
                          className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${isEditing?"bg-emerald-500/20 text-emerald-400":"text-slate-600 hover:text-slate-300"}`}>
                          <Edit2 size={13}/>
                        </button>
                        {/* Move */}
                        <button onClick={()=>setMovingEntryId(isMoving ? null : (setEditingEntryId(null), entry.id))}
                          title="Move to different meal"
                          className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${isMoving?"bg-emerald-500/20 text-emerald-400":"text-slate-600 hover:text-slate-300"}`}>
                          <ArrowLeft size={14} className="rotate-90"/>
                        </button>
                        <button onClick={()=>toggleFavorite(entry)} className={`p-1.5 rounded-lg flex-shrink-0 ${isFav?"text-yellow-400":"text-slate-600 hover:text-slate-400"}`}>
                          <Star size={14} fill={isFav?"currentColor":"none"}/>
                        </button>
                        <button onClick={()=>removeFood(entry.id)} className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 flex-shrink-0">
                          <Trash2 size={14}/>
                        </button>
                      </div>

                      {/* Inline edit panel */}
                      {isEditing && (
                        <div className="px-3 pb-3 pt-1 border-t border-slate-700/50 space-y-2">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Edit amount</p>
                          <div className="flex items-center gap-2">
                            {/* Quick decrement */}
                            <button onClick={()=>setEditAmount(a=>String(Math.max(0.1, r(parseFloat(a||0) - entry.amount))))}
                              className="w-8 h-8 rounded-lg bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center text-lg flex-shrink-0">−</button>
                            <div className="flex-1 relative">
                              <input
                                type="number"
                                step="any"
                                value={editAmount}
                                onChange={e => setEditAmount(e.target.value)}
                                onKeyDown={e => { if(e.key==="Enter") editFood(entry, editAmount); if(e.key==="Escape") setEditingEntryId(null); }}
                                className="w-full bg-slate-700 rounded-xl px-3 py-2 text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                autoFocus
                              />
                            </div>
                            {/* Quick increment */}
                            <button onClick={()=>setEditAmount(a=>String(r(parseFloat(a||0) + entry.amount)))}
                              className="w-8 h-8 rounded-lg bg-slate-700 hover:bg-slate-600 text-white flex items-center justify-center text-lg flex-shrink-0">+</button>
                            <span className="text-slate-400 text-sm flex-shrink-0">{entry.unit}</span>
                          </div>
                          {/* Live calorie preview */}
                          {previewAmt > 0 && previewAmt !== entry.amount && (
                            <p className="text-xs text-slate-400 text-center">
                              {previewCal} kcal
                              <span className={`ml-1 font-semibold ${previewCal > entry.calories ? "text-red-400" : "text-emerald-400"}`}>
                                ({previewCal > entry.calories ? "+" : ""}{previewCal - entry.calories})
                              </span>
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button onClick={()=>setEditingEntryId(null)}
                              className="flex-1 py-1.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold">
                              Cancel
                            </button>
                            <button onClick={()=>editFood(entry, editAmount)}
                              disabled={!editAmount || parseFloat(editAmount) <= 0}
                              className="flex-1 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-semibold disabled:opacity-40">
                              Save
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Inline move panel */}
                      {isMoving && (
                        <div className="px-3 pb-2.5 pt-0.5 border-t border-slate-700/50">
                          <p className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-wider">Move to meal</p>
                          <div className="flex gap-1 flex-wrap">
                            {MEAL_CATEGORIES.map(m => (
                              <button key={m} onClick={() => moveFood(entry.id, m)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all
                                  ${m === entry.meal
                                    ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 cursor-default"
                                    : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
                                {m === entry.meal ? `✓ ${m}` : m}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button onClick={()=>{setAddFoodMeal(meal);setShowModal("addFood");}}
                  className="w-full text-center py-1.5 text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-xl hover:border-slate-600">
                  + Add to {meal}
                </button>
              </div>
            </div>
          );
        })}
        {todayFood.length === 0 && (
          <div className="text-center py-6 border border-dashed border-slate-700 rounded-2xl">
            <Utensils size={28} className="mx-auto mb-2 text-slate-600"/>
            <p className="text-slate-500 text-sm">No food logged yet</p>
          </div>
        )}
      </div>

      {/* Exercise */}
      <div className="px-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">Exercise</h3>
          <Btn onClick={()=>setShowModal("addExercise")} size="sm"><Plus size={14}/> Add</Btn>
        </div>
        <div className="space-y-2">
          {todayExercise.map(ex=>(
            <div key={ex.id} className="bg-slate-800 rounded-xl px-3 py-2.5 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center">
                <Dumbbell size={16} className="text-orange-400"/>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">{ex.name||ex.type}</p>
                <p className="text-xs text-slate-400">{ex.type} {ex.duration?`· ${ex.duration} min`:""}</p>
              </div>
              {ex.caloriesBurned>0 && <span className="text-sm text-orange-400 font-semibold">-{ex.caloriesBurned} kcal</span>}
              <button onClick={()=>removeExercise(ex.id)} className="p-1.5 text-slate-600 hover:text-red-400">
                <Trash2 size={14}/>
              </button>
            </div>
          ))}
          {todayExercise.length===0 && (
            <button onClick={()=>setShowModal("addExercise")}
              className="w-full text-center py-4 text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-2xl hover:border-slate-600 text-sm">
              + Log exercise
            </button>
          )}
        </div>
      </div>

      {/* Weight */}
      <div className="px-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">Weight</h3>
          <Btn onClick={()=>setShowModal("addWeight")} size="sm"><Plus size={14}/> Log</Btn>
        </div>
        {todayWeight.length>0 ? (
          <div className="bg-slate-800 rounded-xl px-4 py-3 flex items-center gap-3">
            <Scale size={20} className="text-purple-400"/>
            <span className="text-xl font-black text-white">{todayWeight[0].weight}</span>
            <span className="text-slate-400">{todayWeight[0].unit}</span>
          </div>
        ) : (
          <button onClick={()=>setShowModal("addWeight")}
            className="w-full text-center py-4 text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-2xl hover:border-slate-600 text-sm">
            + Log today's weight
          </button>
        )}
      </div>

      {/* ── COMPLETE DIARY BUTTON ── */}
      <div className="px-4 pt-4 pb-6">
        <button
          onClick={() => setShowRecap(true)}
          className="w-full py-4 rounded-2xl font-bold text-white text-base transition-all active:scale-95 shadow-lg"
          style={{background:"linear-gradient(135deg,#7c3aed 0%,#4f46e5 50%,#0ea5e9 100%)"}}>
          <div className="flex items-center justify-center gap-2.5">
            <ChefHat size={20}/>
            Complete Diary
          </div>
          <p className="text-xs font-normal opacity-70 mt-0.5">Gusteau's daily summary &amp; 4-week projection</p>
        </button>
      </div>

      {/* Modals */}
      {showModal==="addFood" && (
        <AddFoodModal data={data} onClose={()=>setShowModal(null)} onAdd={addFood}
          defaultMeal={addFoodMeal} userId={user.id}
          onSaveCustomFood={(food) => {
            // Only save if not already in the list
            const exists = data.customFoods.some(f => f.name.toLowerCase() === food.name.toLowerCase());
            if (!exists) updateData({ customFoods: [...data.customFoods, food] });
          }}
        />
      )}
      {showModal==="addExercise" && <AddExerciseModal onClose={()=>setShowModal(null)} onAdd={addExercise}/>}
      {showModal==="addWeight"   && <AddWeightModal   onClose={()=>setShowModal(null)} onAdd={addWeight} user={user}/>}
      {showModal==="addWater"    && <AddWaterModal    onClose={()=>setShowModal(null)} onAdd={addWater}/>}
      {showModal==="addSteps"    && <AddStepsModal    onClose={()=>setShowModal(null)} onSave={saveSteps} user={user} currentTotal={totalSteps}/>}
      {showModal==="userSelect" && (
        <UserSelectModal users={data.users} onSelect={setActiveUser} onClose={()=>setShowModal(null)}/>
      )}
      {showReevaluate && (
        <ReevaluatePlanModal
          user={user}
          latestWeight={
            data.weightEntries
              .filter(e => e.userId === user.id)
              .sort((a,b) => b.date.localeCompare(a.date))[0]?.weight
          }
          onSave={(newGoals, newPlan, newWeight) => {
            updateData({
              users: data.users.map(u => u.id === user.id
                ? { ...u, goals: newGoals, plan: newPlan,
                    bio: { ...u.bio, currentWeight: newWeight } }
                : u
              )
            });
          }}
          onClose={() => setShowReevaluate(false)}
        />
      )}
      {showRecap && (
        <DailyRecapModal
          onClose={() => setShowRecap(false)}
          user={user}
          todayFood={todayFood}
          todayExercise={todayExercise}
          todayWater={todayWater}
          totalSteps={totalSteps}
          data={data}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────
// DAILY RECAP MODAL — Chef Gusteau's end-of-day summary
// ─────────────────────────────────────────
const RECAP_SYSTEM = `You are Chef Gusteau giving a warm, honest, personal end-of-day nutrition summary.

Structure your response EXACTLY like this (use these exact headers):

**Bonjour, {name}! Here is your day:**

**✅ What You Did Well**
[2–3 genuine, specific positives — mention actual numbers from their log]

**📈 Areas to Work On**
[2–3 honest but kind observations — be specific, not vague]

**💡 Tomorrow's Tips**
[2–3 concrete, actionable suggestions for tomorrow]

**⚖️ If Every Day Was Like Today…**
[The 4-week projection in your voice — be encouraging whatever direction it goes. Quote the exact projected weight.]

Keep it warm, personal, and concise (under 300 words). Use your French flair naturally. Do NOT search the web — use only the data provided.`;

const DailyRecapModal = ({ onClose, user, todayFood, todayExercise, todayWater, totalSteps, data }) => {
  const [recap, setRecap]     = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");


  // ── Build the day summary prompt ──────────────────────────────────
  const buildPrompt = () => {
    const goals  = user.goals || {};
    const totalCalIn  = todayFood.reduce((s,e) => s + e.calories, 0);
    const totalCalOut = todayExercise.reduce((s,e) => s + e.caloriesBurned, 0);
    const netCal      = totalCalIn - totalCalOut;
    const totalWaterOz = todayWater.reduce((s,e) => s + e.amount, 0);
    const totalProt   = r(todayFood.reduce((s,e) => s + (e.protein||0), 0));
    const totalCarb   = r(todayFood.reduce((s,e) => s + (e.carbs||0), 0));
    const totalFat    = r(todayFood.reduce((s,e) => s + (e.fat||0), 0));
    const totalSugar  = r(todayFood.reduce((s,e) => s + (e.sugar||0), 0));
    const totalSodium = Math.round(todayFood.reduce((s,e) => s + (e.sodium||0), 0));

    const TDEE   = user.plan?.tdee || goals.calories || 2000;
    const latestWeight = data.weightEntries
      .filter(e => e.userId === user.id)
      .sort((a,b) => b.date.localeCompare(a.date))[0]?.weight
      || user.bio?.currentWeight;

    const dailyBalance   = netCal - TDEE; // positive = surplus
    const weightChange4w = (28 * dailyBalance) / 3500; // lbs
    const projectedWeight = latestWeight
      ? Math.round((latestWeight + weightChange4w) * 10) / 10
      : null;

    // Meal breakdown
    const mealLines = MEAL_CATEGORIES.map(meal => {
      const entries = todayFood.filter(e => e.meal === meal);
      if (!entries.length) return null;
      const cal = entries.reduce((s,e) => s+e.calories, 0);
      const items = entries.map(e => `${e.foodName} (${e.amount}${e.unit}, ${e.calories}kcal)`).join(", ");
      return `  ${meal}: ${items} — ${cal} kcal total`;
    }).filter(Boolean).join("\n");

    const exerciseLines = todayExercise.length
      ? todayExercise.map(e => `  ${e.name||e.type}: ${e.duration}min, -${e.caloriesBurned}kcal${e.steps ? ` (${e.steps.toLocaleString()} steps)` : ""}`).join("\n")
      : "  None logged";

    return `Please give ${user.name} their daily recap.

USER: ${user.name}
GOALS: ${goals.calories||2000} kcal | P:${goals.protein||150}g C:${goals.carbs||200}g F:${goals.fat||65}g | Water:${goals.water||64}oz | Steps:${(goals.steps||10000).toLocaleString()}
TDEE (maintenance): ${TDEE} kcal
CURRENT WEIGHT: ${latestWeight ? `${latestWeight} lbs` : "not logged"}

TODAY'S FOOD:
${mealLines || "  Nothing logged"}

FOOD TOTALS: ${totalCalIn} kcal | P:${totalProt}g C:${totalCarb}g F:${totalFat}g | Sugar:${totalSugar}g | Sodium:${totalSodium}mg

EXERCISE:
${exerciseLines}
${totalSteps > 0 ? `  Steps: ${totalSteps.toLocaleString()} steps` : ""}

NET CALORIES (food minus exercise): ${netCal} kcal
DAILY BALANCE vs TDEE: ${dailyBalance > 0 ? '+' : ''}${Math.round(dailyBalance)} kcal (${dailyBalance > 0 ? 'surplus — gaining' : 'deficit — losing'})
WATER: ${totalWaterOz}/${goals.water||64} oz

4-WEEK PROJECTION:
If every day was like today → ${dailyBalance > 0 ? 'gain' : 'lose'} ${Math.abs(Math.round(weightChange4w * 10) / 10)} lbs in 28 days
${projectedWeight ? `Projected weight in 4 weeks: ${projectedWeight} lbs` : "Cannot calculate — no weight data"}`;
  };

  // ── Call Gusteau ───────────────────────────────────────────────────
  const generate = useCallback(async () => {
    setLoading(true);
    setRecap("");
    setError("");

    try {
      const res = await fetch(AI_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            system: RECAP_SYSTEM,
            messages: [{ role: "user", content: buildPrompt() }],
          }),
        });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const d = await res.json();
        setRecap((d.content || []).filter(b => b.type === "text").map(b => b.text).join(""));
    } catch (e) {
      setError(e.message || "Could not generate recap. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [user, todayFood, todayExercise, todayWater, totalSteps]);

  useEffect(() => { generate(); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose}/>
      <div className="relative bg-slate-800 rounded-t-3xl w-full max-w-md max-h-[88vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
              <ChefHat size={20} className="text-violet-400"/>
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Daily Recap</h2>
              <p className="text-xs text-slate-400">Chef Gusteau's summary</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!loading && !error && (
              <button onClick={generate} title="Regenerate"
                className="p-2 rounded-xl hover:bg-slate-700 text-slate-400 hover:text-white transition-colors">
                <RefreshCw size={16}/>
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-700 text-slate-400">
              <X size={18}/>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="w-12 h-12 rounded-2xl bg-violet-500/20 flex items-center justify-center">
                <ChefHat size={24} className="text-violet-400 animate-pulse"/>
              </div>
              <div className="text-center">
                <p className="text-white font-semibold">Gusteau is reviewing your day…</p>
                <p className="text-slate-400 text-sm mt-1">Analysing your meals, exercise and goals</p>
              </div>
              <div className="flex gap-1">
                {[0,1,2].map(n => (
                  <div key={n} className="w-2 h-2 bg-violet-400 rounded-full animate-bounce"
                    style={{animationDelay:`${n*150}ms`}}/>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <AlertCircle size={32} className="text-red-400"/>
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}

          {!loading && !error && recap && (
            <div className="space-y-1 pb-4">
              {renderAIMessage(recap)}
            </div>
          )}
        </div>

        {/* Footer note */}
        {!loading && !error && (
          <div className="px-5 pb-5 pt-2 flex-shrink-0 border-t border-slate-700/50">
            <p className="text-[11px] text-slate-500 text-center">
              This recap is for guidance only — nothing is recorded or changed · Tap ↺ to regenerate
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────
// COLLECTIVE DIARY
// ─────────────────────────────────────────
const CollectiveDiary = ({ data, dateRange, dateMode }) => {
  const [filterUser, setFilterUser] = useState("all");
  const [filterMeal, setFilterMeal] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [showFilters, setShowFilters] = useState(false);

  const dates = dateMode==="day" ? [dateRange.start] : getDatesInRange(dateRange.start, dateRange.end);

  const userMap = useMemo(()=>Object.fromEntries(data.users.map(u=>[u.id,u])), [data.users]);

  const allEntries = useMemo(()=>{
    let food = data.foodEntries.filter(e=>dates.includes(e.date));
    let exercise = data.exerciseEntries.filter(e=>dates.includes(e.date));
    let weight = data.weightEntries.filter(e=>dates.includes(e.date));
    let water = data.waterEntries.filter(e=>dates.includes(e.date));

    if (filterUser!=="all") {
      food=food.filter(e=>e.userId===filterUser);
      exercise=exercise.filter(e=>e.userId===filterUser);
      weight=weight.filter(e=>e.userId===filterUser);
      water=water.filter(e=>e.userId===filterUser);
    }
    if (filterMeal!=="all") food=food.filter(e=>e.meal===filterMeal);

    const combined = [];
    if (filterType==="all"||filterType==="food") combined.push(...food.map(e=>({...e,_type:"food"})));
    if (filterType==="all"||filterType==="exercise") combined.push(...exercise.map(e=>({...e,_type:"exercise"})));
    if (filterType==="all"||filterType==="weight") combined.push(...weight.map(e=>({...e,_type:"weight"})));
    if (filterType==="all"||filterType==="water") combined.push(...water.map(e=>({...e,_type:"water"})));
    return combined.sort((a,b)=>b.date.localeCompare(a.date));
  }, [data, dates, filterUser, filterMeal, filterType]);

  // Group by date
  const grouped = useMemo(()=>{
    const g = {};
    allEntries.forEach(e=>{ if(!g[e.date]) g[e.date]=[]; g[e.date].push(e); });
    return g;
  }, [allEntries]);

  const renderEntry = (entry) => {
    const user = userMap[entry.userId];
    if (!user) return null;
    if (entry._type==="food") return (
      <div key={entry.id} className="flex items-center gap-3 py-2.5 border-b border-slate-700/30">
        <Avatar user={user} size={28}/>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">{entry.foodName}</p>
          <p className="text-xs text-slate-500">{user.name} · {entry.meal} · {entry.amount}{entry.unit}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-white">{entry.calories} kcal</p>
          <p className="text-[10px] text-slate-500">P:{r(entry.protein)} C:{r(entry.carbs)} F:{r(entry.fat)}</p>
        </div>
      </div>
    );
    if (entry._type==="exercise") return (
      <div key={entry.id} className="flex items-center gap-3 py-2.5 border-b border-slate-700/30">
        <Avatar user={user} size={28}/>
        <div className="flex-1">
          <p className="text-sm text-white">{entry.name||entry.type}</p>
          <p className="text-xs text-slate-500">{user.name} · Exercise · {entry.type}</p>
        </div>
        {entry.caloriesBurned>0 && <p className="text-sm font-bold text-orange-400">-{entry.caloriesBurned} kcal</p>}
      </div>
    );
    if (entry._type==="weight") return (
      <div key={entry.id} className="flex items-center gap-3 py-2.5 border-b border-slate-700/30">
        <Avatar user={user} size={28}/>
        <div className="flex-1">
          <p className="text-sm text-white">{entry.weight}{entry.unit}</p>
          <p className="text-xs text-slate-500">{user.name} · Weight</p>
        </div>
        <Scale size={16} className="text-purple-400"/>
      </div>
    );
    if (entry._type==="water") return (
      <div key={entry.id} className="flex items-center gap-3 py-2.5 border-b border-slate-700/30">
        <Avatar user={user} size={28}/>
        <div className="flex-1">
          <p className="text-sm text-white">{entry.amount}oz water</p>
          <p className="text-xs text-slate-500">{user.name} · Hydration</p>
        </div>
        <Droplets size={16} className="text-blue-400"/>
      </div>
    );
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-bold text-white">All entries</h3>
        <button onClick={()=>setShowFilters(s=>!s)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
            ${showFilters?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>
          <Filter size={13}/> Filters
        </button>
      </div>

      {showFilters && (
        <div className="bg-slate-800 rounded-2xl p-3 mb-4 space-y-3">
          <div>
            <p className="text-xs text-slate-400 mb-1.5">User</p>
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={()=>setFilterUser("all")}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium ${filterUser==="all"?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>All</button>
              {data.users.map(u=>(
                <button key={u.id} onClick={()=>setFilterUser(u.id)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium ${filterUser===u.id?"text-white":"bg-slate-700 text-slate-300"}`}
                  style={filterUser===u.id?{background:u.color}:{}}>
                  {u.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Type</p>
            <div className="flex gap-1.5 flex-wrap">
              {["all","food","exercise","weight","water"].map(t=>(
                <button key={t} onClick={()=>setFilterType(t)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium capitalize ${filterType===t?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>{t}</button>
              ))}
            </div>
          </div>
          {(filterType==="all"||filterType==="food") && (
            <div>
              <p className="text-xs text-slate-400 mb-1.5">Meal</p>
              <div className="flex gap-1.5 flex-wrap">
                <button onClick={()=>setFilterMeal("all")}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium ${filterMeal==="all"?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>All meals</button>
                {MEAL_CATEGORIES.map(m=>(
                  <button key={m} onClick={()=>setFilterMeal(m)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${filterMeal===m?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>{m}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {Object.keys(grouped).length===0 ? (
        <div className="text-center py-12">
          <List size={36} className="mx-auto mb-3 text-slate-700"/>
          <p className="text-slate-500 text-sm">No entries for this period</p>
        </div>
      ) : (
        Object.keys(grouped).sort((a,b)=>b.localeCompare(a)).map(date=>(
          <div key={date} className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{fmtDate(date)}</span>
              <div className="flex-1 h-px bg-slate-700"/>
              <span className="text-xs text-slate-500">{grouped[date].filter(e=>e._type==="food").reduce((s,e)=>s+e.calories,0)} kcal</span>
            </div>
            <div className="bg-slate-800 rounded-2xl px-3 divide-y divide-slate-700/30">
              {grouped[date].map(renderEntry)}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

// ─────────────────────────────────────────
// DIARY PAGE
// ─────────────────────────────────────────
const DiaryPage = ({ data, updateData, activeUser, setActiveUser, dateMode, setDateMode,
  selectedDate, setSelectedDate, customStart, setCustomStart, customEnd, setCustomEnd,
  groupName, hasMultipleGroups, onSwitchGroup }) => {
  const [view, setView] = useState("individual");
  const dateRange = getRangeForMode(dateMode, customStart, customEnd);
  const effectiveDate = dateMode==="day" ? selectedDate : dateRange.start;

  return (
    <div>
      {/* Header */}
      <div className="px-4 pt-5 pb-3 flex items-center justify-between">
        <h1 className="text-2xl font-black text-white flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center">
            <Apple size={18} className="text-white"/>
          </div>
          NutriLog
        </h1>
        {groupName && (
          <button onClick={hasMultipleGroups ? onSwitchGroup : undefined}
            className={`flex items-center gap-1.5 bg-slate-800 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-300 ${hasMultipleGroups?'hover:bg-slate-700 active:scale-95':''} transition-all`}>
            <Users size={12} className="text-emerald-400"/>
            {groupName}
            {hasMultipleGroups && <ChevronDown size={11} className="text-slate-500"/>}
          </button>
        )}
      </div>

      {/* View toggle */}
      <div className="px-4 mb-2">
        <div className="flex bg-slate-800 rounded-xl p-1">
          {[["individual","My Diary"],["collective","Everyone"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setView(id)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all
                ${view===id?"bg-emerald-500 text-white":"text-slate-400 hover:text-white"}`}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Date bar */}
      <DateBar dateMode={dateMode} setDateMode={setDateMode}
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        customStart={customStart} setCustomStart={setCustomStart}
        customEnd={customEnd} setCustomEnd={setCustomEnd}/>

      {view==="individual" ? (
        <IndividualDiary data={data} updateData={updateData}
          activeUser={activeUser} setActiveUser={setActiveUser}
          selectedDate={dateMode==="day"?selectedDate:dateRange.start}/>
      ) : (
        <CollectiveDiary data={data} dateRange={dateRange} dateMode={dateMode}/>
      )}
    </div>
  );
};

// ─────────────────────────────────────────
// REPORTS PAGE
// ─────────────────────────────────────────
const ReportsPage = ({ data }) => {
  const [selUser, setSelUser] = useState("all");
  const [period, setPeriod]   = useState("month");

  const comparing = selUser === "all" && data.users.length > 1;
  const dateRange  = getRangeForMode(period, null, null);
  const dates      = getDatesInRange(dateRange.start, dateRange.end);
  const last14     = dates.slice(-14);

  const userMap    = useMemo(() => Object.fromEntries(data.users.map(u => [u.id, u])), [data.users]);
  const targetUser = selUser !== "all" ? data.users.find(u => u.id === selUser) : null;
  const calorieGoal = targetUser?.goals?.calories || 2000;

  const inRange  = useCallback((e) => dates.includes(e.date) && (selUser === "all" || e.userId === selUser), [dates, selUser]);

  const foodInRange = useMemo(() => data.foodEntries.filter(inRange),      [data.foodEntries, inRange]);
  const exInRange   = useMemo(() => data.exerciseEntries.filter(inRange),   [data.exerciseEntries, inRange]);
  const wtInRange   = useMemo(() => data.weightEntries.filter(inRange),     [data.weightEntries, inRange]);

  // ── Comparison helpers ─────────────────────────────────────────────
  // Grouped bar data: [{ date, "Alice": 1800, "Bob": 2100 }, ...]
  const makeComparisonData = (metricFn) =>
    last14.map(d => {
      const row = { date: fmtDateShort(d) };
      data.users.forEach(u => { row[u.name] = metricFn(u.id, d); });
      return row;
    });

  const hasAnyData = (compData) =>
    compData.some(row => data.users.some(u => (row[u.name] || 0) > 0));

  // ── Single-user data ──────────────────────────────────────────────
  const calVsGoalData = useMemo(() => last14.map(d => ({
    date: fmtDateShort(d),
    calories: foodInRange.filter(e => e.date === d).reduce((s, e) => s + e.calories, 0),
  })), [foodInRange, last14]);

  const netCalData = useMemo(() => last14.map(d => ({
    date: fmtDateShort(d),
    eaten:  foodInRange.filter(e => e.date === d).reduce((s, e) => s + e.calories, 0),
    burned: exInRange.filter(e => e.date === d).reduce((s, e) => s + e.caloriesBurned, 0),
  })), [foodInRange, exInRange, last14]);

  // ── Comparison data ───────────────────────────────────────────────
  const calCompData = useMemo(() => makeComparisonData((uid, d) =>
    data.foodEntries.filter(e => e.userId === uid && e.date === d && dates.includes(d))
      .reduce((s, e) => s + e.calories, 0)
  ), [data.foodEntries, dates, data.users]);

  const netCompData = useMemo(() => last14.map(d => {
    const row = { date: fmtDateShort(d) };
    data.users.forEach(u => {
      const eaten  = data.foodEntries.filter(e => e.userId === u.id && e.date === d).reduce((s, e) => s + e.calories, 0);
      const burned = data.exerciseEntries.filter(e => e.userId === u.id && e.date === d).reduce((s, e) => s + e.caloriesBurned, 0);
      row[u.name] = Math.max(0, eaten - burned);
    });
    return row;
  }), [data, last14]);

  // ── Macros ────────────────────────────────────────────────────────
  const macroCompData = useMemo(() => {
    if (!comparing) {
      const p = foodInRange.reduce((s, e) => s + (e.protein || 0), 0);
      const c = foodInRange.reduce((s, e) => s + (e.carbs   || 0), 0);
      const f = foodInRange.reduce((s, e) => s + (e.fat     || 0), 0);
      return [{ name:"Protein", value:r(p), color:"#6366f1" }, { name:"Carbs", value:r(c), color:"#f59e0b" }, { name:"Fat", value:r(f), color:"#ec4899" }];
    }
    return data.users.map(u => {
      const uf = data.foodEntries.filter(e => e.userId === u.id && dates.includes(e.date));
      return {
        name: u.name, color: u.color,
        Protein: r(uf.reduce((s, e) => s + (e.protein || 0), 0)),
        Carbs:   r(uf.reduce((s, e) => s + (e.carbs   || 0), 0)),
        Fat:     r(uf.reduce((s, e) => s + (e.fat     || 0), 0)),
      };
    });
  }, [comparing, foodInRange, data, dates]);

  // ── Weight trend ──────────────────────────────────────────────────
  const weightLineData = useMemo(() => {
    const allDates = [...new Set(wtInRange.map(w => w.date))].sort();
    return allDates.map(d => {
      const row = { date: fmtDateShort(d) };
      (selUser === "all" ? data.users : [targetUser]).filter(Boolean).forEach(u => {
        const entry = wtInRange.find(w => w.userId === u.id && w.date === d);
        if (entry) row[u.name] = entry.weight;
      });
      return row;
    });
  }, [wtInRange, selUser, data.users, targetUser]);

  // ── Meal breakdown ────────────────────────────────────────────────
  const mealCompData = useMemo(() => {
    if (!comparing) {
      return MEAL_CATEGORIES.map(meal => ({
        meal: meal.replace(" Snack", "Snk"),
        calories: foodInRange.filter(e => e.meal === meal).reduce((s, e) => s + e.calories, 0),
      })).filter(m => m.calories > 0);
    }
    return MEAL_CATEGORIES.map(meal => {
      const row = { meal: meal.replace(" Snack", "Snk") };
      data.users.forEach(u => {
        row[u.name] = data.foodEntries
          .filter(e => e.userId === u.id && e.meal === meal && dates.includes(e.date))
          .reduce((s, e) => s + e.calories, 0);
      });
      return row;
    }).filter(row => data.users.some(u => (row[u.name] || 0) > 0));
  }, [comparing, foodInRange, data, dates]);

  // ── Micronutrients ────────────────────────────────────────────────
  const microData = useMemo(() => {
    const dayCount = Math.max(1, dates.length);
    if (!comparing) return [
      { name:"Sugar (g)",   avg: r(foodInRange.reduce((s,e)=>s+(e.sugar||0),0)/dayCount),              limit:50,   color:"#f97316" },
      { name:"Sodium (mg)", avg: Math.round(foodInRange.reduce((s,e)=>s+(e.sodium||0),0)/dayCount),    limit:2300, color:"#8b5cf6" },
      { name:"Fiber (g)",   avg: r(foodInRange.reduce((s,e)=>s+(e.fiber||0),0)/dayCount),              limit:30,   color:"#10b981" },
    ];
    return data.users.map(u => {
      const uf = data.foodEntries.filter(e => e.userId === u.id && dates.includes(e.date));
      return {
        name: u.name, color: u.color,
        Sugar:  r(uf.reduce((s,e)=>s+(e.sugar||0),0)/dayCount),
        Sodium: Math.round(uf.reduce((s,e)=>s+(e.sodium||0),0)/dayCount),
        Fiber:  r(uf.reduce((s,e)=>s+(e.fiber||0),0)/dayCount),
      };
    });
  }, [comparing, foodInRange, data, dates]);

  // ── Exercise ──────────────────────────────────────────────────────
  const exerciseData = useMemo(() => {
    if (!comparing) return EXERCISE_TYPES.map(type => ({
      type, sessions: exInRange.filter(e=>e.type===type).length,
      duration: exInRange.filter(e=>e.type===type).reduce((s,e)=>s+e.duration,0),
      burned:   exInRange.filter(e=>e.type===type).reduce((s,e)=>s+e.caloriesBurned,0),
    })).filter(e => e.sessions > 0);
    return data.users.map(u => ({
      name: u.name, color: u.color,
      sessions: data.exerciseEntries.filter(e=>e.userId===u.id&&dates.includes(e.date)).length,
      burned:   data.exerciseEntries.filter(e=>e.userId===u.id&&dates.includes(e.date)).reduce((s,e)=>s+e.caloriesBurned,0),
    }));
  }, [comparing, exInRange, data, dates]);

  // ── Streak ────────────────────────────────────────────────────────
  const streakData = useMemo(() => {
    const usersToShow = selUser === "all" ? data.users : data.users.filter(u=>u.id===selUser);
    return usersToShow.map(u => {
      const loggedDates = new Set(data.foodEntries.filter(e=>e.userId===u.id).map(e=>e.date));
      let cur = 0;
      const td = todayStr(); let d = new Date(td+"T00:00:00");
      while (true) { const ds=d.toISOString().slice(0,10); if(loggedDates.has(ds)){cur++;d.setDate(d.getDate()-1);}else break; }
      let sorted=[...loggedDates].sort(), ms=sorted.length>0?1:0, cs=1;
      for(let i=1;i<sorted.length;i++){
        const prev=new Date(sorted[i-1]+"T00:00:00"); prev.setDate(prev.getDate()+1);
        if(prev.toISOString().slice(0,10)===sorted[i]){cs++;ms=Math.max(ms,cs);}else cs=1;
      }
      return { name:u.name, color:u.color, currentStreak:cur, maxStreak:ms, totalDays:loggedDates.size };
    });
  }, [data, selUser]);

  // ── Leaderboard ───────────────────────────────────────────────────
  const leaderboardData = useMemo(() => data.users.map(u => {
    const uf = data.foodEntries.filter(e=>e.userId===u.id&&dates.includes(e.date));
    const daysLogged = new Set(uf.map(e=>e.date)).size;
    const daysOnGoal = dates.filter(d=>{
      const cal=uf.filter(e=>e.date===d).reduce((s,e)=>s+e.calories,0);
      const goal=u.goals?.calories||2000;
      return cal>0 && Math.abs(cal-goal)<=goal*0.1;
    }).length;
    return { name:u.name, color:u.color, daysLogged, daysOnGoal, pctGoal:daysLogged>0?Math.round((daysOnGoal/daysLogged)*100):0 };
  }).sort((a,b)=>b.pctGoal-a.pctGoal), [data, dates]);

  const tt = { contentStyle:{background:"#1e293b",border:"none",borderRadius:8,fontSize:12}, labelStyle:{color:"#fff"} };
  const ax = { tick:{fontSize:10,fill:"#94a3b8"}, tickLine:false, axisLine:false };

  const CompBars = ({ data: cd, height=180 }) => (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={cd} margin={{top:0,right:0,left:-20,bottom:0}}>
        <XAxis dataKey="date" {...ax}/>
        <YAxis {...ax}/>
        <Tooltip {...tt}/>
        <Legend wrapperStyle={{fontSize:11}}/>
        {data.users.map(u => <Bar key={u.id} dataKey={u.name} fill={u.color} radius={[3,3,0,0]}/>)}
      </BarChart>
    </ResponsiveContainer>
  );

  const CompLines = ({ lineData, height=180 }) => (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={lineData} margin={{top:0,right:0,left:-20,bottom:0}}>
        <XAxis dataKey="date" {...ax}/>
        <YAxis {...ax} domain={["auto","auto"]}/>
        <Tooltip {...tt}/>
        <Legend wrapperStyle={{fontSize:11}}/>
        {(selUser==="all"?data.users:[targetUser]).filter(Boolean).map(u => (
          <Line key={u.id} type="monotone" dataKey={u.name} stroke={u.color} strokeWidth={2} dot={{fill:u.color,r:3}} connectNulls/>
        ))}
      </LineChart>
    </ResponsiveContainer>
  );

  const Card = ({ title, icon: Icon, color, children }) => (
    <div className="bg-slate-800 rounded-2xl p-4">
      <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
        <Icon size={16} style={{color}}/> {title}
        {comparing && <span className="text-[10px] text-slate-500 font-normal ml-auto">comparing all users</span>}
      </h3>
      {children}
    </div>
  );

  const noData = <p className="text-slate-500 text-sm text-center py-4">No data yet</p>;

  return (
    <div className="pb-4">
      <div className="px-4 pt-5 pb-3">
        <h1 className="text-2xl font-black text-white">Reports</h1>
      </div>

      {/* Filters */}
      <div className="px-4 space-y-3 mb-4">
        <div className="flex gap-1">
          {[["week","Week"],["month","Month"],["custom","All time"]].map(([v,lbl])=>(
            <button key={v} onClick={()=>setPeriod(v)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${period===v?"bg-emerald-500 text-white":"bg-slate-700 text-slate-400"}`}>{lbl}</button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={()=>setSelUser("all")}
            className={`px-3 py-1 rounded-lg text-xs font-medium ${selUser==="all"?"bg-emerald-500 text-white":"bg-slate-700 text-slate-400"}`}>
            Everyone {comparing && "↔"}
          </button>
          {data.users.map(u=>(
            <button key={u.id} onClick={()=>setSelUser(u.id)}
              className={`px-3 py-1 rounded-lg text-xs font-medium ${selUser===u.id?"text-white":"bg-slate-700 text-slate-400"}`}
              style={selUser===u.id?{background:u.color}:{}}>{u.name}</button>
          ))}
        </div>
        {comparing && (
          <p className="text-xs text-slate-500">Tap a name above to view one person's data individually</p>
        )}
      </div>

      <div className="px-4 space-y-3">

        {/* Calories vs Goal */}
        <Card title="Calories (last 14 days)" icon={Flame} color="#10b981">
          {comparing ? (
            hasAnyData(calCompData) ? <CompBars data={calCompData}/> : noData
          ) : (
            calVsGoalData.every(d=>d.calories===0) ? noData : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={calVsGoalData} margin={{top:0,right:0,left:-20,bottom:0}}>
                  <XAxis dataKey="date" {...ax}/>
                  <YAxis {...ax}/>
                  <Tooltip {...tt}/>
                  <ReferenceLine y={calorieGoal} stroke="#10b981" strokeDasharray="4 4"
                    label={{value:`Goal ${calorieGoal}`,fill:"#10b981",fontSize:10}}/>
                  <Bar dataKey="calories" fill={targetUser?.color||"#6366f1"} radius={[4,4,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            )
          )}
        </Card>

        {/* Macros */}
        <Card title="Macro Breakdown" icon={Activity} color="#6366f1">
          {comparing ? (
            macroCompData.every(u=>u.Protein===0&&u.Carbs===0&&u.Fat===0) ? noData : (
              <div className="space-y-3">
                {macroCompData.map(u => (
                  <div key={u.name}>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2.5 h-2.5 rounded-full" style={{background:u.color}}/>
                      <span className="text-xs font-semibold text-white">{u.name}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {[["Protein",u.Protein,"#6366f1"],["Carbs",u.Carbs,"#f59e0b"],["Fat",u.Fat,"#ec4899"]].map(([lbl,val,col])=>(
                        <div key={lbl} className="bg-slate-700/50 rounded-lg py-1.5">
                          <div className="text-[10px] text-slate-500">{lbl}</div>
                          <div className="text-xs font-bold" style={{color:col}}>{val}g</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            macroCompData.every(m=>m.value===0) ? noData : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width={140} height={140}>
                  <PieChart>
                    <Pie data={macroCompData} dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={60}>
                      {macroCompData.map((m,i)=><Cell key={i} fill={m.color}/>)}
                    </Pie>
                    <Tooltip {...tt}/>
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 flex-1">
                  {macroCompData.map(m=>(
                    <div key={m.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{background:m.color}}/>
                        <span className="text-xs text-slate-300">{m.name}</span>
                      </div>
                      <span className="text-sm font-bold text-white">{m.value}g</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </Card>

        {/* Weight Trend */}
        <Card title="Weight Trend" icon={Scale} color="#8b5cf6">
          {weightLineData.length < 2 ? (
            <p className="text-slate-500 text-sm text-center py-4">Need at least 2 weigh-ins to show a trend</p>
          ) : (
            <CompLines lineData={weightLineData}/>
          )}
        </Card>

        {/* Net Calories */}
        <Card title="Net Calories (last 14 days)" icon={Zap} color="#f59e0b">
          {comparing ? (
            hasAnyData(netCompData) ? <CompBars data={netCompData}/> : noData
          ) : (
            netCalData.every(d=>d.eaten===0) ? noData : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={netCalData} margin={{top:0,right:0,left:-20,bottom:0}}>
                  <XAxis dataKey="date" {...ax}/>
                  <YAxis {...ax}/>
                  <Tooltip {...tt}/>
                  <ReferenceLine y={calorieGoal} stroke="#10b981" strokeDasharray="4 4"/>
                  <Bar dataKey="eaten" name="Eaten" fill={targetUser?.color||"#6366f1"} radius={[4,4,0,0]}/>
                  <Bar dataKey="burned" name="Burned" fill="#10b981" radius={[4,4,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            )
          )}
        </Card>

        {/* Meal Breakdown */}
        <Card title="Calories by Meal" icon={Utensils} color="#ec4899">
          {mealCompData.length === 0 ? noData : comparing ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={mealCompData} layout="vertical" margin={{top:0,right:0,left:0,bottom:0}}>
                <XAxis type="number" {...ax}/>
                <YAxis type="category" dataKey="meal" tick={{fontSize:10,fill:"#94a3b8"}} tickLine={false} width={55}/>
                <Tooltip {...tt}/>
                <Legend wrapperStyle={{fontSize:11}}/>
                {data.users.map(u => <Bar key={u.id} dataKey={u.name} fill={u.color} radius={[0,3,3,0]}/>)}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={mealCompData} layout="vertical" margin={{top:0,right:40,left:0,bottom:0}}>
                <XAxis type="number" {...ax}/>
                <YAxis type="category" dataKey="meal" tick={{fontSize:10,fill:"#94a3b8"}} tickLine={false} width={55}/>
                <Tooltip {...tt}/>
                <Bar dataKey="calories" fill={targetUser?.color||"#ec4899"} radius={[0,4,4,0]}
                  label={{position:"right",fontSize:10,fill:"#94a3b8"}}/>
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        {/* Exercise Summary */}
        <Card title="Exercise Summary" icon={Dumbbell} color="#f97316">
          {comparing ? (
            exerciseData.every(u=>u.sessions===0) ? noData : (
              <div className="space-y-2">
                {exerciseData.map(u=>(
                  <div key={u.name} className="flex items-center gap-3 bg-slate-700/50 rounded-xl px-3 py-2.5">
                    <div className="w-3 h-8 rounded-full flex-shrink-0" style={{background:u.color}}/>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-white">{u.name}</p>
                      <p className="text-xs text-slate-400">{u.sessions} session{u.sessions!==1?"s":""}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-orange-400">{u.burned} kcal</p>
                      <p className="text-xs text-slate-500">burned</p>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            exerciseData.length===0 ? noData : (
              <div className="space-y-2">
                {exerciseData.map(ex=>(
                  <div key={ex.type} className="flex items-center gap-3 bg-slate-700/50 rounded-xl px-3 py-2">
                    <div className="w-2 h-8 rounded-full bg-orange-500"/>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-white">{ex.type}</p>
                      <p className="text-xs text-slate-400">{ex.sessions} session{ex.sessions!==1?"s":""} · {ex.duration} min</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-orange-400">{ex.burned} kcal</p>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </Card>

        {/* Micronutrients */}
        <Card title="Daily Avg Micronutrients" icon={Heart} color="#14b8a6">
          {foodInRange.length===0 ? noData : comparing ? (
            <div className="space-y-4">
              {microData.map(u=>(
                <div key={u.name}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{background:u.color}}/>
                    <span className="text-xs font-semibold text-white">{u.name}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[["Sugar",u.Sugar,"g",50,"#f97316"],["Sodium",u.Sodium,"mg",2300,"#8b5cf6"],["Fiber",u.Fiber,"g",30,"#10b981"]].map(([lbl,val,unit,limit,col])=>(
                      <div key={lbl} className="bg-slate-700/50 rounded-lg py-1.5">
                        <div className="text-[10px] text-slate-500">{lbl}</div>
                        <div className="text-xs font-bold" style={{color:val>limit?"#ef4444":col}}>{val}{unit}</div>
                        <div className="text-[9px] text-slate-600">/{limit}{unit}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {microData.map(m=>(
                <div key={m.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-300">{m.name}</span>
                    <span className="font-semibold" style={{color:m.avg>m.limit?"#ef4444":m.color}}>
                      {m.avg} / {m.limit} {m.name.includes("mg")?"mg":"g"}
                    </span>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full">
                    <div className="h-full rounded-full" style={{width:`${Math.min((m.avg/m.limit)*100,100)}%`,background:m.avg>m.limit?"#ef4444":m.color}}/>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Logging Streak */}
        <Card title="Logging Streak" icon={Calendar} color="#3b82f6">
          {streakData.length===0 ? noData : (
            <div className="space-y-3">
              {streakData.map(u=>(
                <div key={u.name} className="flex items-center gap-3 bg-slate-700/50 rounded-xl px-3 py-2">
                  <div className="w-3 h-10 rounded-full flex-shrink-0" style={{background:u.color}}/>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-white">{u.name}</p>
                    <p className="text-xs text-slate-400">{u.totalDays} total days logged</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-black" style={{color:u.color}}>{u.currentStreak}</p>
                    <p className="text-[10px] text-slate-500">day streak</p>
                  </div>
                  <div className="text-right border-l border-slate-600 pl-3">
                    <p className="text-sm font-bold text-slate-300">{u.maxStreak}</p>
                    <p className="text-[10px] text-slate-500">best</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Leaderboard */}
        <Card title="Leaderboard" icon={Trophy} color="#f59e0b">
          <p className="text-xs text-slate-500 mb-3">% of logged days hitting calorie goal (±10%)</p>
          {leaderboardData.every(u=>u.daysLogged===0) ? noData : (
            <div className="space-y-2">
              {leaderboardData.map((u,i)=>(
                <div key={u.name} className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-black flex-shrink-0"
                    style={{background:i===0?"#f59e0b":i===1?"#9ca3af":i===2?"#cd7c2f":"#1e293b",color:"white"}}>
                    {i+1}
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-semibold text-white">{u.name}</span>
                      <span style={{color:u.color}}>{u.pctGoal}%</span>
                    </div>
                    <div className="h-2 bg-slate-700 rounded-full">
                      <div className="h-full rounded-full" style={{width:`${u.pctGoal}%`,background:u.color}}/>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5">{u.daysLogged} days · {u.daysOnGoal} on goal</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

      </div>
    </div>
  );
};


// ─────────────────────────────────────────
// USER EDITOR MODAL
// ─────────────────────────────────────────
// ─────────────────────────────────────────
// BIOMETRICS & PLAN CALCULATION
// ─────────────────────────────────────────
const getAge = (dob) => {
  if (!dob) return null;
  const today = new Date(), birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
};

const ACTIVITY_LEVELS = [
  { id:"sedentary",         label:"Sedentary",          desc:"Little/no exercise, desk job",          mult:1.2 },
  { id:"lightly_active",    label:"Lightly Active",     desc:"Light exercise 1–3 days/week",           mult:1.375 },
  { id:"moderately_active", label:"Moderately Active",  desc:"Moderate exercise 3–5 days/week",        mult:1.55 },
  { id:"very_active",       label:"Very Active",        desc:"Hard exercise 6–7 days/week",            mult:1.725 },
  { id:"extremely_active",  label:"Extremely Active",   desc:"Physical job + daily training",          mult:1.9 },
];

const GOAL_TYPES = [
  { id:"lose",     label:"Lose Weight",   icon:"📉" },
  { id:"maintain", label:"Maintain",      icon:"⚖️" },
  { id:"gain",     label:"Build Muscle",  icon:"💪" },
];

const WEEKLY_TARGETS = [0.5, 1, 1.5, 2];

const calculatePlan = (bio, currentWeightOverride) => {
  const { dob, gender, heightFt, heightIn, goalWeight, activityLevel, goalType, weeklyTarget } = bio;
  const currentWeight = currentWeightOverride ?? bio.currentWeight;
  if (!dob || !heightFt || !currentWeight) return null;

  const age = getAge(dob);
  if (!age || age < 10 || age > 110) return null;

  // Convert to metric
  const heightCm = ((+heightFt * 12) + (+heightIn || 0)) * 2.54;
  const weightKg  = currentWeight * 0.453592;

  // Mifflin-St Jeor BMR
  const base = (10 * weightKg) + (6.25 * heightCm) - (5 * age);
  const bmr = gender === "male" ? base + 5 : gender === "female" ? base - 161 : base - 78;

  // TDEE
  const mult = ACTIVITY_LEVELS.find(a => a.id === activityLevel)?.mult || 1.55;
  const tdee = Math.round(bmr * mult);

  // Calorie goal
  const adjPerDay = ((weeklyTarget || 1) * 3500) / 7;
  let calories = goalType === "lose" ? tdee - adjPerDay
               : goalType === "gain" ? tdee + adjPerDay
               : tdee;
  const minCal = gender === "male" ? 1500 : 1200;
  calories = Math.max(Math.round(calories), minCal);

  // Macros
  const proteinPerLb = goalType === "lose" ? 1.0 : goalType === "gain" ? 0.9 : 0.8;
  const targetLbsForProtein = goalType === "lose" ? (goalWeight || currentWeight) : currentWeight;
  const protein = Math.round(targetLbsForProtein * proteinPerLb);
  const proteinCal = protein * 4;
  const fat     = Math.round((calories * 0.27) / 9);
  const fatCal  = fat * 9;
  const carbs   = Math.max(Math.round((calories - proteinCal - fatCal) / 4), 50);

  // Water: half body weight in oz
  const water = Math.round(currentWeight / 2);

  return { calories, protein, carbs, fat, water, tdee,
    calculatedAt: todayStr(), currentWeight };
};

// ─────────────────────────────────────────
// STEP CALORIE CALCULATION
// Firstbeat-inspired: stride length from height → distance → MET → net active calories
// ─────────────────────────────────────────
const calculateStepCalories = (steps, bio) => {
  const { gender, heightFt, heightIn, currentWeight } = bio || {};
  if (!steps || steps <= 0 || !currentWeight || !heightFt) return null;

  const weightKg   = Number(currentWeight) * 0.453592;
  const heightCm   = (Number(heightFt) * 12 + Number(heightIn || 0)) * 2.54;

  // Step length scaled from population averages (Garmin/Firstbeat methodology)
  // Reference: 76cm/step for 175cm male, 66cm/step for 165cm female
  const refStep   = gender === 'female' ? 0.66 : 0.76; // metres at reference height
  const refHeight = gender === 'female' ? 165  : 175;   // cm
  const stepM     = refStep * (heightCm / refHeight);   // personalised step length

  // Distance
  const distKm = (steps * stepM) / 1000;
  const distMi = distKm * 0.621371;

  // Assume brisk walking pace: 5.6 km/h (3.5 mph) — typical daily activity pace
  const speedKmh   = 5.6;
  const durationH  = distKm / speedKmh;
  const durationMin = Math.round(durationH * 60);

  // MET 4.3 = brisk walking 5.6 km/h (Ainsworth Compendium of Physical Activities)
  // Firstbeat approach: NET active calories = (MET − 1) × weight_kg × hours
  // Subtracting 1 MET removes the resting metabolic component already counted in goals
  const MET = 4.3;
  const netCal = Math.round((MET - 1.0) * weightKg * durationH);

  return {
    calories:   Math.max(netCal, Math.round(steps * 0.03)), // floor safety
    distMi:     Math.round(distMi * 10) / 10,
    distKm:     Math.round(distKm * 10) / 10,
    durationMin,
  };
};
// ─────────────────────────────────────────
const PlanSummaryCard = ({ plan, goals, onChange, editable = true }) => {
  if (!plan && !goals) return null;
  const vals = goals || {};
  const fields = [
    ["Calories","calories","kcal",500,4000,50,"#10b981"],
    ["Protein","protein","g",50,300,5,"#6366f1"],
    ["Carbs","carbs","g",50,500,5,"#f59e0b"],
    ["Fat","fat","g",20,200,5,"#ec4899"],
    ["Water","water","oz",16,200,4,"#3b82f6"],
  ];
  return (
    <div className="bg-slate-700/50 rounded-2xl p-4 space-y-3">
      {plan && (
        <div className="flex justify-between text-xs text-slate-400 pb-1 border-b border-slate-600">
          <span>Based on your stats · TDEE {plan.tdee} kcal</span>
          <span>Calculated {plan.calculatedAt}</span>
        </div>
      )}
      {fields.map(([lbl, key, unit, min, max, step, color]) => (
        <div key={key}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">{lbl}</span>
            <span className="font-bold" style={{color}}>{vals[key] ?? 0} {unit}</span>
          </div>
          {editable && (
            <input type="range" min={min} max={max} step={step} value={vals[key] ?? 0}
              onChange={e => onChange(key, +e.target.value)}
              className="w-full" style={{accentColor: color}}/>
          )}
          {!editable && (
            <div className="h-1.5 bg-slate-700 rounded-full">
              <div className="h-full rounded-full" style={{
                width:`${Math.min(((vals[key]??0)/max)*100,100)}%`, background: color
              }}/>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────
// USER EDITOR MODAL (multi-step for new users)
// ─────────────────────────────────────────
const UserEditorModal = ({ user, onSave, onClose, isNew, fullPage = false }) => {
  const [step, setStep] = useState(0);
  const [passcode, setPasscode] = useState(user?.passcode || "");
  const [changePass, setChangePass] = useState(isNew || !user?.passcode);

  const [form, setForm] = useState(() => user || {
    id: uid(), name: "", color: USER_COLORS[0], passcode: null,
    bio: { dob:"", gender:"", heightFt:5, heightIn:8, currentWeight:"", goalWeight:"",
           activityLevel:"moderately_active", goalType:"lose", weeklyTarget:1 },
    goals: { calories:2000, protein:150, carbs:200, fat:65, water:64, steps:10000 },
  });

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const setBio = (k, v) => setForm(p => ({ ...p, bio: { ...p.bio, [k]: v } }));
  const setGoal = (k, v) => setForm(p => ({ ...p, goals: { ...p.goals, [k]: v } }));

  // Recalculate goals from bio
  const recalc = (overrideBio) => {
    const bio = overrideBio || form.bio;
    const plan = calculatePlan(bio);
    if (plan) setForm(p => ({ ...p,
      goals: { calories:plan.calories, protein:plan.protein, carbs:plan.carbs, fat:plan.fat, water:plan.water },
      plan,
    }));
    return plan;
  };

  const STEPS_NEW = ["Identity", "Body Stats", "Your Goals", "Your Plan"];
  const totalSteps = isNew ? STEPS_NEW.length : 1;

  // Step validation
  const step0Valid = form.name.trim().length > 0;
  const step1Valid = form.bio.dob && form.bio.gender && form.bio.heightFt && form.bio.currentWeight;
  const step2Valid = form.bio.goalType === "maintain" || form.bio.goalWeight;

  const goNext = () => {
    if (step === 1) recalc(); // auto-calc when moving to goals
    if (step === 2) recalc(); // re-calc when moving to plan
    setStep(s => s + 1);
  };

  const save = () => {
    onSave({ ...form, passcode: changePass ? (passcode || null) : user?.passcode });
    if (!fullPage) onClose();
  };

  // ── EDIT MODE (existing user): one scrollable form ──────────────────
  if (!isNew) return (
    <Modal title="Edit User" onClose={onClose}>
      <div className="p-4 space-y-4 pb-8">
        {/* Identity */}
        <input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Name"
          className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
        <div>
          <p className="text-xs text-slate-400 mb-2">Colour</p>
          <div className="flex gap-2 flex-wrap">
            {USER_COLORS.map(c => (
              <button key={c} onClick={() => set("color", c)}
                className="w-9 h-9 rounded-full border-2 transition-all"
                style={{background:c, borderColor:form.color===c?"white":"transparent"}}/>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-white">Passcode</p>
            <button onClick={() => setChangePass(s => !s)} className="text-xs text-emerald-400">
              {changePass ? "Cancel" : "Change"}
            </button>
          </div>
          {changePass
            ? <PasscodeInput value={passcode} onChange={setPasscode} placeholder="Passcode (leave blank for none)"/>
            : <p className="text-sm text-slate-400">{user?.passcode ? "Protected" : "No passcode"}</p>}
        </div>

        {/* Biometrics */}
        <div className="bg-slate-700/50 rounded-xl p-3 space-y-3">
          <p className="text-sm font-semibold text-white">Body Stats</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-slate-400 mb-1">Date of birth</p>
              <input type="date" value={form.bio?.dob||""} max={`${new Date().getFullYear()-13}-12-31`}
                onChange={e => setBio("dob", e.target.value)}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Gender</p>
              <select value={form.bio?.gender||""} onChange={e => setBio("gender", e.target.value)}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500">
                <option value="">Select</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Prefer not to say</option>
              </select>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Height</p>
              <div className="flex gap-1">
                <select value={form.bio?.heightFt||5} onChange={e => setBio("heightFt", +e.target.value)}
                  className="flex-1 bg-slate-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none">
                  {[4,5,6,7].map(n => <option key={n} value={n}>{n}ft</option>)}
                </select>
                <select value={form.bio?.heightIn||8} onChange={e => setBio("heightIn", +e.target.value)}
                  className="flex-1 bg-slate-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none">
                  {Array.from({length:12},(_,i)=>i).map(n => <option key={n} value={n}>{n}in</option>)}
                </select>
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Current weight (lbs)</p>
              <input type="number" value={form.bio?.currentWeight||""} onChange={e => setBio("currentWeight", +e.target.value)}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Goal weight (lbs)</p>
              <input type="number" value={form.bio?.goalWeight||""} onChange={e => setBio("goalWeight", +e.target.value)}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"/>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-1">Goal type</p>
              <select value={form.bio?.goalType||"lose"} onChange={e => setBio("goalType", e.target.value)}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                {GOAL_TYPES.map(g => <option key={g.id} value={g.id}>{g.icon} {g.label}</option>)}
              </select>
            </div>
          </div>
          {form.bio?.goalType !== "maintain" && (
            <div>
              <p className="text-xs text-slate-400 mb-1">Target change per week</p>
              <div className="flex gap-1">
                {WEEKLY_TARGETS.map(t => (
                  <button key={t} onClick={() => setBio("weeklyTarget", t)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all
                      ${form.bio?.weeklyTarget===t?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300"}`}>
                    {t} lb
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-xs text-slate-400 mb-1">Activity level</p>
            <div className="space-y-1">
              {ACTIVITY_LEVELS.map(a => (
                <button key={a.id} onClick={() => setBio("activityLevel", a.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-all ${form.bio?.activityLevel===a.id?"bg-emerald-500/20 border border-emerald-500/40":"bg-slate-700/50 hover:bg-slate-700"}`}>
                  <p className="text-xs font-semibold text-white">{a.label}</p>
                  <p className="text-[11px] text-slate-400">{a.desc}</p>
                </button>
              ))}
            </div>
          </div>
          <Btn onClick={() => recalc()} variant="secondary" className="w-full" size="sm">
            <RefreshCw size={13}/> Recalculate goals from stats
          </Btn>
        </div>

        {/* Goals (manual override) */}
        <PlanSummaryCard goals={form.goals} plan={form.plan} onChange={setGoal}/>

        <div className="flex gap-2 pt-2">
          <Btn onClick={onClose} variant="secondary" className="flex-1">Cancel</Btn>
          <Btn onClick={save} disabled={!form.name.trim()} className="flex-1">Save</Btn>
        </div>
      </div>
    </Modal>
  );

  // ── NEW USER: multi-step wizard ─────────────────────────────────────
  const wizardInner = (
    <div className={fullPage ? "w-full max-w-sm mx-auto px-4 pt-6 pb-12" : "p-4 pb-8"}>
      {fullPage && (
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-3">
            <Apple size={24} className="text-white"/>
          </div>
          <h1 className="text-xl font-black text-white">Set Up Your Profile</h1>
          <p className="text-slate-400 text-sm mt-1">We'll calculate your personalised calorie and macro goals</p>
        </div>
      )}
      {/* Step indicator */}
      <div className="flex gap-1 mb-5">
        {STEPS_NEW.map((s, i) => (
          <div key={i} className={`flex-1 h-1 rounded-full transition-all ${i <= step ? "bg-emerald-500" : "bg-slate-700"}`}/>
        ))}
      </div>
        <p className="text-xs text-slate-500 mb-4 uppercase tracking-wider">{STEPS_NEW[step]}</p>

        {/* ── Step 0: Identity ── */}
        {step === 0 && (
          <div className="space-y-4">
            <input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Full name"
              className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            <div>
              <p className="text-xs text-slate-400 mb-2">Colour</p>
              <div className="flex gap-2 flex-wrap">
                {USER_COLORS.map(c => (
                  <button key={c} onClick={() => set("color", c)}
                    className="w-10 h-10 rounded-full border-2 transition-all"
                    style={{background:c, borderColor:form.color===c?"white":"transparent"}}/>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-2">Personal passcode <span className="text-slate-600">(optional)</span></p>
              <PasscodeInput value={passcode} onChange={setPasscode} placeholder="Leave blank for no passcode"/>
            </div>
            <Btn onClick={() => setStep(1)} disabled={!step0Valid} className="w-full" size="lg">
              Next <ChevronRight size={16}/>
            </Btn>
          </div>
        )}

        {/* ── Step 1: Body Stats ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-white mb-1">Date of birth</p>
              <input type="date" value={form.bio.dob} max={`${new Date().getFullYear()-13}-12-31`}
                min={`${new Date().getFullYear()-100}-01-01`}
                onChange={e => setBio("dob", e.target.value)}
                className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
              {form.bio.dob && <p className="text-xs text-slate-500 mt-1">Age: {getAge(form.bio.dob)}</p>}
            </div>

            <div>
              <p className="text-sm font-semibold text-white mb-2">Biological sex <span className="text-xs text-slate-500 font-normal">(used for calorie calculation)</span></p>
              <div className="flex gap-2">
                {[["male","♂ Male"],["female","♀ Female"],["other","Prefer not to say"]].map(([val,lbl]) => (
                  <button key={val} onClick={() => setBio("gender", val)}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all
                      ${form.bio.gender===val?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold text-white mb-2">Height</p>
              <div className="flex gap-3">
                <div className="flex-1">
                  <select value={form.bio.heightFt} onChange={e => setBio("heightFt", +e.target.value)}
                    className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    {[4,5,6,7].map(n => <option key={n} value={n}>{n} ft</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <select value={form.bio.heightIn} onChange={e => setBio("heightIn", +e.target.value)}
                    className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    {Array.from({length:12},(_,i)=>i).map(n => <option key={n} value={n}>{n} in</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold text-white mb-2">Current weight (lbs)</p>
              <input type="number" value={form.bio.currentWeight} placeholder="e.g. 185"
                onChange={e => setBio("currentWeight", e.target.value)}
                className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            </div>

            <div className="flex gap-2">
              <Btn onClick={() => setStep(0)} variant="secondary" className="flex-1">Back</Btn>
              <Btn onClick={goNext} disabled={!step1Valid} className="flex-1">
                Next <ChevronRight size={16}/>
              </Btn>
            </div>
          </div>
        )}

        {/* ── Step 2: Goals ── */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-white mb-2">My goal is to…</p>
              <div className="space-y-2">
                {GOAL_TYPES.map(g => (
                  <button key={g.id} onClick={() => setBio("goalType", g.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all
                      ${form.bio.goalType===g.id?"bg-emerald-500/20 border border-emerald-500/50":"bg-slate-700/50 hover:bg-slate-700"}`}>
                    <span className="text-2xl">{g.icon}</span>
                    <span className="text-white font-semibold text-sm">{g.label}</span>
                    {form.bio.goalType===g.id && <Check size={16} className="text-emerald-400 ml-auto"/>}
                  </button>
                ))}
              </div>
            </div>

            {form.bio.goalType !== "maintain" && (
              <>
                <div>
                  <p className="text-sm font-semibold text-white mb-2">Goal weight (lbs)</p>
                  <input type="number" value={form.bio.goalWeight} placeholder="e.g. 165"
                    onChange={e => setBio("goalWeight", e.target.value)}
                    className="w-full bg-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
                </div>
                <div>
                  <p className="text-sm font-semibold text-white mb-2">
                    {form.bio.goalType==="lose" ? "Lose" : "Gain"} per week
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {WEEKLY_TARGETS.map(t => (
                      <button key={t} onClick={() => setBio("weeklyTarget", t)}
                        className={`py-3 rounded-xl text-sm font-bold transition-all
                          ${form.bio.weeklyTarget===t?"bg-emerald-500 text-white":"bg-slate-700 text-slate-300 hover:bg-slate-600"}`}>
                        {t}<br/><span className="text-[10px] font-normal">lb/wk</span>
                      </button>
                    ))}
                  </div>
                  {form.bio.weeklyTarget >= 1.5 && (
                    <p className="text-xs text-yellow-400 mt-2 flex items-center gap-1">
                      <AlertCircle size={11}/> {form.bio.weeklyTarget >= 2 ? "Aggressive — only recommended short term." : "Moderate pace — sustainable for most people."}
                    </p>
                  )}
                </div>
              </>
            )}

            <div>
              <p className="text-sm font-semibold text-white mb-2">Activity level</p>
              <div className="space-y-1.5">
                {ACTIVITY_LEVELS.map(a => (
                  <button key={a.id} onClick={() => setBio("activityLevel", a.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl transition-all
                      ${form.bio.activityLevel===a.id?"bg-emerald-500/20 border border-emerald-500/40":"bg-slate-700/50 hover:bg-slate-700"}`}>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-white">{a.label}</p>
                      {form.bio.activityLevel===a.id && <Check size={14} className="text-emerald-400"/>}
                    </div>
                    <p className="text-xs text-slate-400">{a.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Btn onClick={() => setStep(1)} variant="secondary" className="flex-1">Back</Btn>
              <Btn onClick={goNext} disabled={!step2Valid} className="flex-1">
                Calculate Plan <ChevronRight size={16}/>
              </Btn>
            </div>
          </div>
        )}

        {/* ── Step 3: Plan Review ── */}
        {step === 3 && (
          <div className="space-y-4">
            {form.plan && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 space-y-1">
                <p className="text-emerald-300 font-bold text-sm">Your personalised plan is ready!</p>
                <p className="text-xs text-slate-400">
                  TDEE: <span className="text-white font-semibold">{form.plan.tdee} kcal</span> ·
                  Goal: <span className="text-white font-semibold">{form.goals.calories} kcal/day</span> ·
                  Est. {form.bio.goalType === "maintain" ? "maintenance" :
                    `${form.bio.goalType === "lose" ? "-" : "+"}${form.bio.weeklyTarget} lb/wk`}
                </p>
              </div>
            )}
            <p className="text-xs text-slate-400">Adjust any goal using the sliders — these are always editable later in Settings.</p>
            <PlanSummaryCard goals={form.goals} plan={form.plan} onChange={setGoal}/>
            <div className="flex gap-2">
              <Btn onClick={() => setStep(2)} variant="secondary" className="flex-1">Back</Btn>
              <Btn onClick={save} disabled={!form.name.trim()} className="flex-1">
                <Check size={16}/> Let's go!
              </Btn>
            </div>
          </div>
        )}
      </div>
  );

  if (fullPage) return (
    <div className="min-h-screen bg-slate-900 text-white overflow-auto">
      {wizardInner}
    </div>
  );

  return (
    <Modal title="Add User" onClose={onClose}>
      {wizardInner}
    </Modal>
  );
};

// ─────────────────────────────────────────
// REEVALUATE PLAN MODAL
// ─────────────────────────────────────────
const ReevaluatePlanModal = ({ user, latestWeight, onSave, onClose }) => {
  const currentWeight = latestWeight || user.bio?.currentWeight;
  const newPlan = useMemo(() => calculatePlan(user.bio || {}, currentWeight), [user, currentWeight]);
  const [goals, setGoals] = useState(
    newPlan
      ? { calories:newPlan.calories, protein:newPlan.protein, carbs:newPlan.carbs, fat:newPlan.fat, water:newPlan.water }
      : { ...user.goals }
  );
  const setGoal = (k, v) => setGoals(p => ({ ...p, [k]: v }));

  const age = getAge(user.bio?.dob);
  const weightChange = latestWeight && user.bio?.currentWeight
    ? (latestWeight - user.bio.currentWeight).toFixed(1)
    : null;

  if (!user.bio?.dob) return (
    <Modal title="Reevaluate Plan" onClose={onClose}>
      <div className="p-6 text-center space-y-3">
        <AlertCircle size={36} className="mx-auto text-yellow-400"/>
        <p className="text-white font-semibold">No biometric data found</p>
        <p className="text-slate-400 text-sm">Ask an admin to update your profile with your height, weight, and date of birth first.</p>
        <Btn onClick={onClose} variant="secondary" className="w-full">Close</Btn>
      </div>
    </Modal>
  );

  return (
    <Modal title="Reevaluate My Plan" onClose={onClose}>
      <div className="p-4 space-y-4 pb-8">
        {/* What changed */}
        <div className="bg-slate-700/50 rounded-xl p-3 space-y-1.5 text-sm">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-2">Using current data</p>
          <div className="flex justify-between">
            <span className="text-slate-400">Age</span>
            <span className="text-white font-semibold">{age} years old</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Current weight</span>
            <span className="text-white font-semibold">
              {currentWeight} lbs
              {weightChange && weightChange !== "0.0" && (
                <span className={`ml-2 text-xs ${+weightChange < 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ({+weightChange > 0 ? "+" : ""}{weightChange} lbs since setup)
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">New TDEE</span>
            <span className="text-white font-semibold">{newPlan?.tdee ?? "—"} kcal</span>
          </div>
        </div>

        {/* Old vs new */}
        {newPlan && (
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-slate-800 rounded-xl p-3">
              <p className="text-xs text-slate-500 mb-2">Previous goal</p>
              {[["Cal",user.goals?.calories,"#64748b"],["Pro",user.goals?.protein+"g","#64748b"],
                ["Carb",user.goals?.carbs+"g","#64748b"],["Fat",user.goals?.fat+"g","#64748b"]].map(([l,v,c])=>(
                <div key={l} className="flex justify-between text-xs px-1">
                  <span className="text-slate-500">{l}</span>
                  <span style={{color:c}}>{v}</span>
                </div>
              ))}
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3">
              <p className="text-xs text-emerald-400 mb-2">New plan</p>
              {[["Cal",goals.calories,"#10b981"],["Pro",goals.protein+"g","#6366f1"],
                ["Carb",goals.carbs+"g","#f59e0b"],["Fat",goals.fat+"g","#ec4899"]].map(([l,v,c])=>(
                <div key={l} className="flex justify-between text-xs px-1">
                  <span className="text-slate-400">{l}</span>
                  <span className="font-bold" style={{color:c}}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400">Fine-tune the new plan before saving:</p>
        <PlanSummaryCard goals={goals} plan={newPlan} onChange={setGoal}/>

        <div className="flex gap-2">
          <Btn onClick={onClose} variant="secondary" className="flex-1">Keep old plan</Btn>
          <Btn onClick={() => { onSave(goals, newPlan, currentWeight); onClose(); }} className="flex-1">
            <Check size={16}/> Apply new plan
          </Btn>
        </div>
      </div>
    </Modal>
  );
};


// ─────────────────────────────────────────
const SettingsPage = ({ data, updateData, onSignOut, authUser, activeUser,
  activeGroupId, userGroups, onSwitchGroup, onJoinGroup, onCreateGroup }) => {

  const isAdmin = (data.groupAdmins || []).includes(authUser?.uid);
  const [editUser, setEditUser]           = useState(null);
  const [addingUser, setAddingUser]       = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(null);

  const saveUser = (user) => {
    const exists = data.users.find(u => u.id === user.id);
    if (exists) updateData({ users: data.users.map(u => u.id===user.id ? user : u) });
    else         updateData({ users: [...data.users, user] });
  };

  const deleteUser = (userId) => {
    updateData({
      users:           data.users.filter(u=>u.id!==userId),
      foodEntries:     data.foodEntries.filter(e=>e.userId!==userId),
      exerciseEntries: data.exerciseEntries.filter(e=>e.userId!==userId),
      weightEntries:   data.weightEntries.filter(e=>e.userId!==userId),
      waterEntries:    data.waterEntries.filter(e=>e.userId!==userId),
      favorites:       data.favorites.filter(f=>f.userId!==userId),
    });
    setShowConfirmDelete(null);
  };

  const exportAll = () => {
    const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `nutrilog-export-${todayStr()}.json`; a.click();
  };

  return (
    <div className="pb-8">
      <div className="px-4 pt-5 pb-4">
        <h1 className="text-2xl font-black text-white">Settings</h1>
      </div>

      {/* ── My Profile ─────────────────────────────────────────────── */}
      <div className="px-4 mb-6">
        <h2 className="text-base font-bold text-white mb-3 flex items-center gap-2">
          <User size={16} className="text-emerald-400"/> My Profile
        </h2>
        <div className="bg-slate-800 rounded-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-black text-white flex-shrink-0"
              style={{background: activeUser?.color || '#6366f1'}}>
              {activeUser?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-white">{activeUser?.name || 'Unknown'}</p>
              <p className="text-xs text-slate-400 truncate">{authUser?.email}</p>
            </div>
            <Btn size="sm" variant="secondary" onClick={() => setEditUser(activeUser)}>
              <Edit2 size={13}/> Edit
            </Btn>
          </div>
        </div>
      </div>

      {/* ── My Groups ──────────────────────────────────────────────── */}
      <div className="px-4 mb-6">
        <h2 className="text-base font-bold text-white mb-3 flex items-center gap-2">
          <Users size={16} className="text-emerald-400"/> My Groups
        </h2>
        <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
          {userGroups.map(g => (
            <div key={g.id} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${g.id===activeGroupId?'bg-emerald-500/10 border border-emerald-500/30':'bg-slate-700/50'}`}>
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                <Users size={14} className="text-emerald-400"/>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{g.name}</p>
                <p className="text-xs text-slate-500">{g.members?.length||0} member{g.members?.length!==1?'s':''}</p>
              </div>
              {g.id === activeGroupId
                ? <span className="text-xs text-emerald-400 font-semibold flex-shrink-0">Active</span>
                : <button onClick={() => onSwitchGroup(g.id)}
                    className="text-xs text-slate-300 bg-slate-600 hover:bg-slate-500 px-2.5 py-1 rounded-lg font-medium flex-shrink-0">
                    Switch
                  </button>
              }
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={onJoinGroup}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold">
              <LogIn size={13}/> Join Group
            </button>
            <button onClick={onCreateGroup}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold">
              <Plus size={13}/> Create Group
            </button>
          </div>
          {userGroups.length > 1 && (
            <button onClick={async () => {
              const isOnlyAdmin = isAdmin && (data.groupAdmins||[]).length === 1;
              if (isOnlyAdmin) { alert("Promote another admin before leaving."); return; }
              if (!confirm(`Leave "${data.groupName}"?`)) return;
              await updateDoc(doc(db, 'groups', activeGroupId), { members: arrayRemove(authUser.uid), admins: arrayRemove(authUser.uid) });
              await updateDoc(doc(db, 'users', authUser.uid), { groups: arrayRemove(activeGroupId) });
              onSwitchGroup(userGroups.find(g=>g.id!==activeGroupId)?.id);
            }}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-red-400 hover:bg-red-400/10 text-xs font-medium transition-colors">
              <DoorOpen size={13}/> Leave "{data.groupName}"
            </button>
          )}
        </div>
      </div>

      {/* ── Sign out ───────────────────────────────────────────────── */}
      <div className="px-4 mb-6">
        <div className="bg-slate-800 rounded-2xl p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-white">Signed in as</p>
            <p className="text-xs text-slate-400">{authUser?.email}</p>
          </div>
          <Btn onClick={onSignOut} variant="danger" size="sm">
            <LogOut size={14}/> Sign out
          </Btn>
        </div>
      </div>

      {/* ── Group Administration (admins only) ─────────────────────── */}
      {isAdmin && (
        <>
          <div className="px-4 mb-2">
            <div className="flex items-center gap-2">
              <Crown size={13} className="text-yellow-400"/>
              <p className="text-xs font-bold text-yellow-400 uppercase tracking-wider">Group Administration</p>
            </div>
          </div>

          {/* Group info */}
          <div className="px-4 mb-4">
            <div className="bg-slate-800 rounded-2xl p-4 space-y-4">
              {/* Group name */}
              <div>
                <p className="text-sm font-semibold text-white mb-2">Group Name</p>
                <div className="flex gap-2">
                  <input id="groupNameInput" defaultValue={data.groupName}
                    className="flex-1 bg-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
                  <Btn size="sm" onClick={async () => {
                    const v = document.getElementById('groupNameInput').value.trim();
                    if (v && v !== data.groupName) {
                      await updateDoc(doc(db, 'groups', activeGroupId), { name: v });
                      updateData({ groupName: v });
                    }
                  }}><Check size={14}/> Save</Btn>
                </div>
              </div>

              {/* Invite code */}
              <div>
                <p className="text-sm font-semibold text-white mb-1">Invite Code</p>
                <p className="text-xs text-slate-500 mb-2">Share with anyone you want to invite</p>
                <div className="flex items-center gap-2 bg-slate-700 rounded-xl px-4 py-3 mb-2">
                  <Hash size={15} className="text-emerald-400 flex-shrink-0"/>
                  <span className="text-2xl font-black text-white tracking-widest flex-1">{data.inviteCode}</span>
                  <button onClick={() => navigator.clipboard?.writeText(data.inviteCode)}
                    className="p-1.5 rounded-lg hover:bg-slate-600 text-slate-400 hover:text-white">
                    <Copy size={15}/>
                  </button>
                </div>
                <Btn size="sm" variant="secondary" onClick={async () => {
                  const code = generateInviteCode();
                  await updateDoc(doc(db, 'groups', activeGroupId), { inviteCode: code });
                  updateData({ inviteCode: code });
                }}><RefreshCw size={13}/> Regenerate</Btn>
              </div>
            </div>
          </div>

          {/* Members */}
          <div className="px-4 mb-4">
            <h2 className="text-base font-bold text-white mb-3 flex items-center gap-2">
              <Users size={16} className="text-emerald-400"/>
              Members ({data.users.length})
              <button onClick={() => setAddingUser(true)}
                className="ml-auto flex items-center gap-1 text-xs text-emerald-400 font-semibold">
                <UserPlus size={13}/> Add
              </button>
            </h2>
            <div className="bg-slate-800 rounded-2xl p-4 space-y-2">
              {data.users.map(member => {
                const memberIsAdmin = (data.groupAdmins||[]).includes(member.id);
                const isSelf        = member.id === authUser?.uid;
                const onlyAdmin     = memberIsAdmin && (data.groupAdmins||[]).length === 1;
                return (
                  <div key={member.id} className="flex items-center gap-3 bg-slate-700/50 rounded-xl px-3 py-2.5">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                      style={{background: member.color}}>
                      {member.name?.[0]?.toUpperCase()||'?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{member.name}{isSelf&&' (you)'}</p>
                      <p className="text-xs text-slate-400 truncate">{member.googleEmail}</p>
                    </div>
                    {memberIsAdmin && (
                      <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-semibold flex-shrink-0">Admin</span>
                    )}
                    <div className="flex gap-1">
                      <button onClick={() => setEditUser(member)} title="Edit profile"
                        className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-400/10 transition-colors">
                        <Edit2 size={13}/>
                      </button>
                      {!isSelf && (
                        <>
                          <button
                            onClick={async () => {
                              if (memberIsAdmin) {
                                if (onlyAdmin) { alert("Can't remove the last admin."); return; }
                                await updateDoc(doc(db,'groups',activeGroupId),{admins:arrayRemove(member.id)});
                                updateData({groupAdmins:(data.groupAdmins||[]).filter(id=>id!==member.id)});
                              } else {
                                await updateDoc(doc(db,'groups',activeGroupId),{admins:arrayUnion(member.id)});
                                updateData({groupAdmins:[...(data.groupAdmins||[]),member.id]});
                              }
                            }}
                            title={memberIsAdmin?"Remove admin":"Make admin"}
                            className={`p-1.5 rounded-lg transition-colors ${memberIsAdmin?'text-yellow-400 hover:bg-yellow-400/10':'text-slate-500 hover:text-yellow-400 hover:bg-yellow-400/10'}`}>
                            <Crown size={13}/>
                          </button>
                          <button
                            onClick={() => setShowConfirmDelete(member.id)}
                            title="Remove from group"
                            className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors">
                            <UserMinus size={13}/>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Export ─────────────────────────────────────────────────── */}
      <div className="px-4 mb-6">
        <h2 className="text-base font-bold text-white mb-3 flex items-center gap-2">
          <Download size={16} className="text-emerald-400"/> Export Data
        </h2>
        <div className="bg-slate-800 rounded-2xl p-4 space-y-3">
          <p className="text-sm text-slate-400">Export all group data as a JSON file for backup or analysis.</p>
          <Btn onClick={exportAll} className="w-full"><Download size={16}/> Export all data</Btn>
        </div>
      </div>

      {/* ── Custom Foods ───────────────────────────────────────────── */}
      <div className="px-4 mb-6">
        <h2 className="text-base font-bold text-white mb-3 flex items-center gap-2">
          <Apple size={16} className="text-emerald-400"/> Custom Foods
        </h2>
        <div className="bg-slate-800 rounded-2xl p-4">
          {data.customFoods.length === 0 ? (
            <p className="text-sm text-slate-400">No custom foods yet. Add them from the diary food search.</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-auto">
              {data.customFoods.map(f => (
                <div key={f.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-white">{f.name}</p>
                    <p className="text-xs text-slate-500">{f.cal} kcal / {f.serving}{f.unit}</p>
                  </div>
                  <button onClick={() => updateData({customFoods:data.customFoods.filter(c=>c.id!==f.id)})}
                    className="p-1.5 text-red-400 hover:text-red-300">
                    <Trash2 size={14}/>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── About ──────────────────────────────────────────────────── */}
      <div className="px-4">
        <div className="bg-slate-800/50 rounded-2xl p-4 text-center">
          <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center mx-auto mb-2">
            <Apple size={20} className="text-white"/>
          </div>
          <p className="text-white font-bold">NutriLog</p>
          <p className="text-xs text-slate-500 mt-1">Multi-group nutrition tracker</p>
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {(editUser || addingUser) && (
        <UserEditorModal
          user={addingUser ? null : editUser}
          isNew={addingUser}
          onSave={user => { saveUser(user); setEditUser(null); setAddingUser(false); }}
          onClose={() => { setEditUser(null); setAddingUser(false); }}
        />
      )}
      {showConfirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/60" onClick={()=>setShowConfirmDelete(null)}/>
          <div className="relative bg-slate-800 rounded-2xl p-6 w-full max-w-sm text-center">
            <AlertCircle size={40} className="text-red-400 mx-auto mb-3"/>
            <h3 className="text-white font-bold text-lg mb-1">Remove member?</h3>
            <p className="text-slate-400 text-sm mb-5">
              This will remove {data.users.find(u=>u.id===showConfirmDelete)?.name} from the group and delete their diary data. Cannot be undone.
            </p>
            <div className="flex gap-2">
              <Btn onClick={()=>setShowConfirmDelete(null)} variant="secondary" className="flex-1">Cancel</Btn>
              <Btn onClick={async () => {
                const uid = showConfirmDelete;
                await updateDoc(doc(db,'groups',activeGroupId),{members:arrayRemove(uid),admins:arrayRemove(uid)});
                await deleteDoc(doc(db,'groups',activeGroupId,'profiles',uid));
                deleteUser(uid);
              }} variant="danger" className="flex-1">Remove</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const AI_SYSTEM = `You are Chef Gusteau — the legendary French chef, brought to life as a warm, enthusiastic culinary guide inside NutriLog.

Your guiding philosophy is simple: "Anyone can cook!" You believe that great food is not reserved for the talented few — it is available to anyone willing to try, to taste, to experiment with joy.

Your personality:
• Warm, generous, and deeply encouraging — you celebrate every attempt in the kitchen
• Passionately French — you occasionally use French words or phrases (mon ami, magnifique, voilà, c'est parfait, non non non, etc.) but never so much that it becomes confusing
• Philosophical about food — you speak of ingredients with reverence, as if they each have a story
• You quote your own motto "Anyone can cook!" when it fits naturally
• Playful but never condescending — you treat every cook as a fellow artist
• You are specific and practical — beautiful words paired with real, actionable recipes

MANDATORY NUTRITION RULE — this is non-negotiable:
Every single recipe response MUST include a nutrition line in EXACTLY this format, with no exceptions:
Serves: X | ~XXX kcal per serving | P:Xg C:Xg F:Xg | Sugar:Xg Sodium:Xmg Fiber:Xg

CRITICAL: The nutrition line must contain PLAIN NUMBERS ONLY — no bold (**), no italic (*), no markdown formatting of any kind inside the nutrition line. Write it exactly as shown above. Formatting the numbers (e.g. **28g**) breaks the app's parser.
All seven values are required every time: kcal, protein (P), carbs (C), fat (F), sugar, sodium (in mg), and fiber.
Round to the nearest whole number. Estimate carefully using the ingredients listed.
Never omit this line, even for simple dishes, snacks, drinks, or nutrition questions.

Structure every recipe response like this:

**Recipe Name**
Serves: X | ~XXX kcal per serving | P:Xg C:Xg F:Xg | Sugar:Xg Sodium:Xmg Fiber:Xg

**Ingredients**
- ...

**Method**
1. ...

**Chef Gusteau's tip:** [one personal, flavourful piece of advice]

**Source:** [link or inspiration if searched from the web]

Always search the web for current, accurate recipes and cite your sources. Be encouraging, be specific, be Gusteau.`;

const renderAIMessage = (text) => {
  // Simple markdown-lite renderer
  const lines = text.split("\n");
  return lines.map((line, i) => {
    if (line.startsWith("**") && line.endsWith("**"))
      return <p key={i} className="font-bold text-white mt-2 first:mt-0">{line.slice(2,-2)}</p>;
    if (line.startsWith("**"))
      return <p key={i} className="font-bold text-emerald-300 mt-2 first:mt-0">{line.replace(/\*\*/g,"")}</p>;
    if (line.startsWith("- ") || line.startsWith("• "))
      return <li key={i} className="ml-3 text-slate-200 text-sm">{line.slice(2)}</li>;
    if (/^\d+\.\s/.test(line))
      return <li key={i} className="ml-3 text-slate-200 text-sm list-decimal">{line.replace(/^\d+\.\s/,"")}</li>;
    if (line.trim() === "") return <div key={i} className="h-1"/>;
    // linkify URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    if (urlRegex.test(line)) {
      const parts = line.split(urlRegex);
      return (
        <p key={i} className="text-slate-200 text-sm">
          {parts.map((part, j) =>
            /^https?:\/\//.test(part)
              ? <a key={j} href={part} target="_blank" rel="noopener noreferrer"
                  className="text-blue-400 underline underline-offset-2 break-all flex items-center gap-1 inline-flex">
                  <ExternalLink size={11}/>{part}
                </a>
              : part
          )}
        </p>
      );
    }
    return <p key={i} className="text-slate-200 text-sm">{line}</p>;
  });
};

const SUGGESTIONS = [
  "Give me a high-protein 400 kcal lunch, Gusteau!",
  "What are the macros in a chicken Caesar salad?",
  "Suggest a French-inspired meal plan for 1800 kcal/day",
  "Find me a healthy low-calorie pasta recipe",
  "What should I eat after a workout, mon ami?",
];

const CHAT_STORAGE_KEY = "nutrilog-chat-v1";
const GREETING = "Ah, bonjour, mon ami! I am Chef Gusteau — and I am delighted you are here. You know what I always say: anyone can cook! Whether you seek a magnificent recipe, wish to understand your nutrition, or simply need a little inspiration in the kitchen — I am at your service. What shall we create together today? 🍽️";

const extractRecipeTitle = (text) => {
  // Try to find **Title** pattern first
  const boldMatch = text.match(/\*\*([^*]{3,60})\*\*/);
  if (boldMatch) return boldMatch[1].replace(/^recipe name[:\s]*/i, "").trim();
  // Fall back to first non-empty line
  const firstLine = text.split("\n").find(l => l.trim().length > 3);
  return (firstLine || "Saved Recipe").slice(0, 60).trim();
};

const AIChatPage = ({ data, updateData, activeUser }) => {
  const [chatView, setChatView] = useState("chat");
  const [messages, setMessages] = useState([{ role: "assistant", text: GREETING }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedToast, setSavedToast] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, chatView]);

  const user = activeUser ? data.users.find(u => u.id === activeUser.id) : null;
  const userContext = user
    ? `\n\nCurrent user context: ${user.name}, daily goal ${user.goals?.calories||2000} kcal, protein ${user.goals?.protein||150}g, carbs ${user.goals?.carbs||200}g, fat ${user.goals?.fat||65}g.`
    : "";


  const saveRecipe = (text) => {
    const title = extractRecipeTitle(text);
    const recipe = { id: uid(), title, content: text, savedAt: new Date().toISOString() };
    updateData({ savedRecipes: [...(data.savedRecipes || []), recipe] });
    setSavedToast(title);
    setTimeout(() => setSavedToast(""), 3000);
  };

  const deleteRecipe = (id) => {
    updateData({ savedRecipes: (data.savedRecipes || []).filter(r => r.id !== id) });
  };

  const clearChat = () => setMessages([{ role: "assistant", text: GREETING }]);

  const sendMessage = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;

    setInput("");
    setError("");
    const newMessages = [...messages, { role: "user", text: userText }];
    setMessages(newMessages);
    setLoading(true);

    // Trim to last 10 messages (5 pairs) to keep token costs manageable
    const MAX_HISTORY = 10;
    const allApiMessages = newMessages
      .slice(newMessages[0].role === "assistant" ? 1 : 0)
      .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));
    const apiMessages = allApiMessages.slice(-MAX_HISTORY);

    try {
      let currentMessages = apiMessages;
      let finalText = "";
      let turns = 0;
      while (turns < 3) {   // max 3 turns to control costs
        turns++;
        const res = await fetch(AI_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            system: AI_SYSTEM + userContext,
            messages: currentMessages,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error?.message || `API error ${res.status}`);
        }
        const d = await res.json();
        const textBlocks = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
        if (textBlocks) finalText += textBlocks;
        if (d.stop_reason !== "tool_use") break;
        const toolBlocks = (d.content || []).filter(b => b.type === "tool_use");
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: d.content },
          { role: "user", content: toolBlocks.map(b => ({ type: "tool_result", tool_use_id: b.id, content: "ok" })) },
        ];
      }
      setMessages(prev => [...prev, { role: "assistant", text: finalText || "I couldn't generate a response. Please try again." }]);
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const savedRecipes = data.savedRecipes || [];

  return (
    <div className="flex flex-col h-screen pb-16">
      {/* Header */}
      <div className="px-4 pt-5 pb-3 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
              <ChefHat size={22} className="text-violet-400"/>
            </div>
            <div>
              <h1 className="text-xl font-black text-white">Chef Gusteau</h1>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Globe size={10}/> "Anyone can cook!" · Searches the web
              </p>
            </div>
          </div>
          {chatView === "chat" && messages.length > 1 && (
            <button onClick={clearChat}
              className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-800">
              <RefreshCw size={12}/> Clear
            </button>
          )}
        </div>

        {/* Tab toggle */}
        <div className="flex bg-slate-800 rounded-xl p-1 mt-3">
          <button onClick={() => setChatView("chat")}
            className={`flex-1 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5
              ${chatView === "chat" ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>
            <MessageSquare size={14}/> Chat
          </button>
          <button onClick={() => setChatView("saved")}
            className={`flex-1 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5
              ${chatView === "saved" ? "bg-violet-500 text-white" : "text-slate-400 hover:text-white"}`}>
            <Star size={14}/> Saved
            {savedRecipes.length > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold
                ${chatView === "saved" ? "bg-white/20 text-white" : "bg-violet-500/20 text-violet-400"}`}>
                {savedRecipes.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Toast */}
      {savedToast && (
        <div className="mx-4 mt-3 flex-shrink-0 bg-emerald-500/20 border border-emerald-500/30 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <Check size={16} className="text-emerald-400 flex-shrink-0"/>
          <p className="text-emerald-300 text-sm font-medium">Saved: {savedToast}</p>
        </div>
      )}

      {/* ── CHAT VIEW ── */}
      {chatView === "chat" && (
        <>
          <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0">
                    <Bot size={14} className="text-violet-400"/>
                  </div>
                )}
                <div className="flex flex-col gap-1 max-w-[85%]">
                  <div className={`rounded-2xl px-4 py-3 ${
                    msg.role === "user"
                      ? "bg-emerald-600 text-white rounded-br-sm"
                      : "bg-slate-800 rounded-bl-sm"
                  }`}>
                    {msg.role === "assistant"
                      ? <div className="space-y-0.5">{renderAIMessage(msg.text)}</div>
                      : <p className="text-sm">{msg.text}</p>
                    }
                  </div>
                  {/* Save button on assistant messages */}
                  {msg.role === "assistant" && i > 0 && (
                    <button onClick={() => saveRecipe(msg.text)}
                      className="self-start ml-1 flex items-center gap-1 text-[11px] text-slate-500 hover:text-violet-400 transition-colors px-2 py-1 rounded-lg hover:bg-slate-800">
                      <Star size={11}/> Save recipe
                    </button>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center mr-2 flex-shrink-0">
                  <Bot size={14} className="text-violet-400"/>
                </div>
                <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                  <div className="flex gap-1">
                    {[0,1,2].map(n => (
                      <div key={n} className="w-2 h-2 bg-slate-500 rounded-full animate-bounce"
                        style={{animationDelay:`${n*150}ms`}}/>
                    ))}
                  </div>
                  <span className="text-slate-400 text-xs ml-1">Gusteau is thinking… &amp; searching…</span>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5"/>
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}
            <div ref={bottomRef}/>
          </div>

          {messages.length <= 1 && (
            <div className="px-4 pb-2 flex-shrink-0">
              <p className="text-xs text-slate-500 mb-2">Try asking…</p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} onClick={() => sendMessage(s)}
                    className="flex-shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-2 rounded-xl border border-slate-700 hover:border-violet-500/50 transition-all">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="px-4 pb-4 pt-2 border-t border-slate-800 flex-shrink-0 bg-slate-900">
            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Ask about recipes, nutrition, meal plans…"
                rows={1}
                className="flex-1 bg-slate-800 rounded-2xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
                style={{minHeight:44, maxHeight:120}}
              />
              <button onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                className="w-11 h-11 rounded-2xl bg-violet-500 flex items-center justify-center flex-shrink-0 disabled:opacity-40 hover:bg-violet-400 transition-all active:scale-95">
                <Send size={18} className="text-white"/>
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── SAVED RECIPES VIEW ── */}
      {chatView === "saved" && (
        <div className="flex-1 overflow-auto px-4 py-4">
          {savedRecipes.length === 0 ? (
            <div className="text-center py-16">
              <Star size={40} className="mx-auto mb-3 text-slate-700"/>
              <p className="text-slate-400 font-semibold mb-1">No saved recipes yet</p>
              <p className="text-slate-500 text-sm">Ask Chef Gusteau for a recipe, then tap<br/>"Save recipe" under its response.</p>
              <button onClick={() => setChatView("chat")}
                className="mt-5 px-4 py-2 bg-violet-500 text-white text-sm font-semibold rounded-xl hover:bg-violet-400 transition-all">
                Go to Chat
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {[...savedRecipes].reverse().map(recipe => (
                <SavedRecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  onDelete={() => deleteRecipe(recipe.id)}
                  onRename={(newTitle) => updateData({
                    savedRecipes: (data.savedRecipes || []).map(r =>
                      r.id === recipe.id ? { ...r, title: newTitle } : r
                    )
                  })}
                  onSaveAsFood={(food) => {
                    const already = (data.customFoods || []).some(f => f.name === food.name);
                    if (!already) updateData({ customFoods: [...(data.customFoods || []), food] });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────
// Parse nutrition from Gusteau's formatted recipe text
// Looks for: ~250 kcal per serving | P:30g C:20g F:8g
// ─────────────────────────────────────────
const parseRecipeNutrition = (text) => {
  // Strip markdown bold/italic so "P:**28g**" becomes "P:28g"
  const clean = text.replace(/\*+/g, '').replace(/_+/g, '');

  const cal    = clean.match(/~?(\d+(?:\.\d+)?)\s*kcal/i);
  const prot   = clean.match(/P\s*:\s*(\d+(?:\.\d+)?)g/i);
  const carbs  = clean.match(/C\s*:\s*(\d+(?:\.\d+)?)g/i);
  const fat    = clean.match(/F\s*:\s*(\d+(?:\.\d+)?)g/i);
  const sugar  = clean.match(/Sugar\s*:\s*(\d+(?:\.\d+)?)g/i);
  const sodium = clean.match(/Sodium\s*:\s*(\d+(?:\.\d+)?)mg/i);
  const fiber  = clean.match(/Fi(?:b(?:er|re))\s*:\s*(\d+(?:\.\d+)?)g/i);

  return {
    cal:    cal    ? Math.round(parseFloat(cal[1]))   : 0,
    p:      prot   ? parseFloat(prot[1])              : 0,
    c:      carbs  ? parseFloat(carbs[1])             : 0,
    f:      fat    ? parseFloat(fat[1])               : 0,
    sugar:  sugar  ? parseFloat(sugar[1])             : 0,
    sodium: sodium ? Math.round(parseFloat(sodium[1])): 0,
    fiber:  fiber  ? parseFloat(fiber[1])             : 0,
  };
};

const SavedRecipeCard = ({ recipe, onDelete, onSaveAsFood, onRename }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [foodSaved, setFoodSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(recipe.title);
  const nameRef = useRef(null);

  useEffect(() => {
    if (editing) { nameRef.current?.focus(); nameRef.current?.select(); }
  }, [editing]);

  const commitRename = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== recipe.title) onRename(trimmed);
    else setNameInput(recipe.title);
    setEditing(false);
  };

  const handleNameKey = (e) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") { setNameInput(recipe.title); setEditing(false); }
  };

  const nutrition = useMemo(() => parseRecipeNutrition(recipe.content), [recipe.content]);
  const hasNutrition = nutrition.cal > 0;

  const copyToClipboard = () => {
    navigator.clipboard?.writeText(recipe.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSaveAsFood = () => {
    onSaveAsFood({
      id: uid(),
      name: recipe.title,
      ...nutrition,
      serving: 1,
      unit: "serving",
    });
    setFoodSaved(true);
    setTimeout(() => setFoodSaved(false), 3000);
  };

  const savedDate = new Date(recipe.savedAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });

  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden">
      <button onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-700/50 transition-all">
        <div className="w-9 h-9 rounded-xl bg-violet-500/20 flex items-center justify-center flex-shrink-0">
          <ChefHat size={18} className="text-violet-400"/>
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-1.5 pr-2" onClick={e => e.stopPropagation()}>
              <input
                ref={nameRef}
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={handleNameKey}
                onBlur={commitRename}
                className="flex-1 min-w-0 bg-slate-700 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
              <button onClick={commitRename} className="text-emerald-400 hover:text-emerald-300 flex-shrink-0">
                <Check size={15}/>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 group">
              <p className="text-white font-semibold text-sm truncate">{recipe.title}</p>
              <button
                onClick={e => { e.stopPropagation(); setNameInput(recipe.title); setEditing(true); }}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-violet-400 transition-all flex-shrink-0">
                <Pencil size={12}/>
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs text-slate-500">Saved {savedDate}</p>
            {hasNutrition && (
              <span className="text-[10px] text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded-full">
                {nutrition.cal} kcal/serving
              </span>
            )}
          </div>
        </div>
        {expanded
          ? <ChevronUp size={16} className="text-slate-400 flex-shrink-0"/>
          : <ChevronDown size={16} className="text-slate-400 flex-shrink-0"/>}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-700/50 pt-3">
          <div className="text-sm space-y-1">
            {renderAIMessage(recipe.content)}
          </div>

          {/* Nutrition preview */}
          {hasNutrition && (
            <div className="bg-slate-900/50 rounded-xl p-3 space-y-2">
              <div className="grid grid-cols-4 gap-2 text-center">
                {[["Cal",nutrition.cal,"#10b981"],["Protein",nutrition.p+"g","#6366f1"],
                  ["Carbs",nutrition.c+"g","#f59e0b"],["Fat",nutrition.f+"g","#ec4899"]].map(([l,v,c])=>(
                  <div key={l}>
                    <div className="text-[10px] text-slate-500">{l}</div>
                    <div className="text-xs font-bold" style={{color:c}}>{v}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center border-t border-slate-700/50 pt-2">
                {[["Sugar",nutrition.sugar+"g","#f97316"],["Sodium",nutrition.sodium+"mg","#8b5cf6"],["Fiber",nutrition.fiber+"g","#14b8a6"]].map(([l,v,c])=>(
                  <div key={l}>
                    <div className="text-[10px] text-slate-500">{l}</div>
                    <div className="text-xs font-semibold" style={{color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            {/* Save as custom food */}
            <button onClick={handleSaveAsFood}
              className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-semibold transition-all
                ${foodSaved
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : hasNutrition
                    ? "bg-violet-500/20 hover:bg-violet-500/30 text-violet-300 border border-violet-500/20"
                    : "bg-slate-700 text-slate-500 cursor-not-allowed opacity-50"}`}
              disabled={!hasNutrition || foodSaved}
              title={!hasNutrition ? "No nutrition data found in this recipe" : ""}>
              {foodSaved
                ? <><Check size={13}/> Added to foods!</>
                : <><Plus size={13}/> Save as custom food</>}
            </button>

            {/* Copy */}
            <button onClick={copyToClipboard}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-semibold transition-all">
              {copied ? <><Check size={13} className="text-emerald-400"/> Copied!</> : <><Copy size={13}/> Copy text</>}
            </button>
          </div>

          {!hasNutrition && (
            <p className="text-[11px] text-slate-500 text-center">
              Nutrition data not detected — ask Gusteau to include kcal and macros in his response.
            </p>
          )}

          <button onClick={onDelete}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium transition-all">
            <Trash2 size={13}/> Delete recipe
          </button>
        </div>
      )}
    </div>
  );
};


export default function App() {
  // ── Auth state ──────────────────────────────────────────────────────
  const [authUser, setAuthUser]         = useState(null);
  // loading | signedOut | checking | noGroup | groupPicker | loadingGroup | newUser | allowed
  const [authStage, setAuthStage]       = useState('loading');
  const [groupFlow, setGroupFlow]       = useState(null); // 'create' | 'join' | null
  const [signInErr, setSignInErr]       = useState('');
  const [signInLoading, setSignInLoading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr]     = useState('');

  // ── Group state ─────────────────────────────────────────────────────
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [userGroups, setUserGroups]       = useState([]); // [{id,name,admins,members}]
  const [hasOldData, setHasOldData]       = useState(false);

  // ── App state ───────────────────────────────────────────────────────
  const [data, setData]                   = useState(null);
  const [dataLoading, setDataLoading]     = useState(false);
  const [activeTab, setActiveTab]         = useState('diary');
  const [activeUser, setActiveUser]       = useState(null);
  const [dateMode, setDateMode]           = useState('day');
  const [selectedDate, setSelectedDate]   = useState(todayStr());
  const [customStart, setCustomStart]     = useState(todayStr());
  const [customEnd, setCustomEnd]         = useState(todayStr());
  const prevDataRef       = useRef(null);
  const syncTimer         = useRef(null);
  const dataRef           = useRef(null);
  const activeGroupIdRef  = useRef(null); // updated synchronously; guards stale onSnapshot callbacks
  const userGroupsRef     = useRef([]);   // always current groups list for cross-sync
  const activeUserRef     = useRef(null); // always current user for cross-sync

  // Keep refs in sync with state for use in callbacks/closures
  useEffect(() => { userGroupsRef.current  = userGroups;  }, [userGroups]);
  useEffect(() => { activeUserRef.current  = activeUser;  }, [activeUser]);

  // ── STAGE 1: Auth listener ──────────────────────────────────────────
  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (!user) {
        setAuthUser(null); setData(null); setActiveUser(null);
        setActiveGroupId(null); setUserGroups([]);
        setAuthStage('signedOut');
      } else {
        setAuthUser(user);
        setAuthStage('checking');
      }
    });
  }, []);

  // ── STAGE 2: Load user's groups ─────────────────────────────────────
  useEffect(() => {
    if (authStage !== 'checking' || !authUser) return;
    let active = true;
    (async () => {
      try {
        const [userDoc, householdSnap] = await Promise.all([
          getDoc(doc(db, 'users', authUser.uid)),
          getDoc(doc(db, 'households', 'main')),
        ]);
        if (!active) return;

        // Flag old data for migration offer
        if (householdSnap.exists()) setHasOldData(true);

        const groupIds = userDoc.exists() ? (userDoc.data().groups || []) : [];

        if (groupIds.length === 0) { setAuthStage('noGroup'); return; }

        const groupDocs = await Promise.all(groupIds.map(id => getDoc(doc(db, 'groups', id))));
        if (!active) return;
        const groups = groupDocs.filter(d => d.exists()).map(d => ({id:d.id,...d.data()}));
        setUserGroups(groups);

        if (groups.length === 1) {
          setActiveGroupId(groups[0].id);
          setAuthStage('loadingGroup');
        } else {
          setAuthStage('groupPicker');
        }
      } catch(e) {
        if (!active) return;
        setSignInErr(`Connection error: ${e.message}`);
        setAuthStage('signedOut');
      }
    })();
    return () => { active = false; };
  }, [authStage, authUser]);

  // ── STAGE 3: Load selected group's data ────────────────────────────
  useEffect(() => {
    if (authStage !== 'loadingGroup' || !authUser || !activeGroupId) return;
    let active = true;
    (async () => {
      try {
        setDataLoading(true);
        const appData = await loadFromFirestore(activeGroupId);
        if (!active) return;
        setData(appData);
        prevDataRef.current = appData;
        dataRef.current     = appData;
        setDataLoading(false);
        const myProfile = appData.users.find(u => u.googleEmail === authUser.email);
        if (myProfile) {
          setActiveUser(myProfile);
          setAuthStage('allowed');

          // Cross-sync diary to all other groups on every load (covers page refresh,
          // first open after adding a new group, and catches any missed writes)
          const otherGroupIds = userGroupsRef.current
            .filter(g => g.id !== activeGroupId)
            .map(g => g.id);
          if (otherGroupIds.length > 0) {
            crossSyncDiary(otherGroupIds, {}, appData, DIARY_KEYS, myProfile.id)
              .catch(console.error);
          }
        }
        else            { setAuthStage('newUser'); }
      } catch(e) {
        if (!active) return;
        setDataLoading(false);
        setSignInErr(`Failed to load group: ${e.message}`);
        setAuthStage('signedOut');
      }
    })();
    return () => { active = false; };
  }, [authStage, authUser, activeGroupId]);

  // ── STAGE 4: Real-time listeners ────────────────────────────────────
  useEffect(() => {
    if (authStage !== 'allowed' || !activeGroupId) return;
    const gp = `groups/${activeGroupId}`;

    // Capture the group ID at subscription time.
    // guard() discards any queued Firestore event that fires after a group
    // switch — Firestore does not guarantee callbacks stop immediately on unsub.
    const myGroupId = activeGroupId;
    activeGroupIdRef.current = myGroupId;
    const guard = (fn) => (...args) => {
      if (activeGroupIdRef.current !== myGroupId) return;
      fn(...args);
    };

    const unsubs = [
      ...COLLECTIONS.map(c => onSnapshot(collection(db, gp, c), guard(snap => {
        const key = STATE_KEY[c] || c;
        const items = snap.docs.map(d => ({...d.data(), id: d.id}));
        setData(prev => {
          if (!prev) return prev;
          const next = {...prev, [key]: items};
          dataRef.current = next;
          if (!syncTimer.current) prevDataRef.current = next;
          return next;
        });
      }))),
      onSnapshot(collection(db, gp, 'profiles'), guard(snap => {
        const users = snap.docs.map(d => ({...d.data(), id: d.id}));
        setData(prev => {
          if (!prev) return prev;
          const next = {...prev, users};
          dataRef.current = next;
          if (!syncTimer.current) prevDataRef.current = next;
          return next;
        });
      })),
      onSnapshot(doc(db, 'groups', activeGroupId), guard(snap => {
        if (!snap.exists()) return;
        const g = snap.data();
        setData(prev => {
          if (!prev) return prev;
          const next = {...prev,
            adminPasscode: g.adminPasscode, anthropicKey: g.anthropicKey || '',
            groupName: g.name, groupAdmins: g.admins || [],
            groupMembers: g.members || [], inviteCode: g.inviteCode || '',
          };
          dataRef.current = next;
          if (!syncTimer.current) prevDataRef.current = next;
          return next;
        });
      })),
    ];
    return () => unsubs.forEach(u => u());
  }, [authStage, activeGroupId]);


  // ── updateData ───────────────────────────────────────────────────────
  const updateData = useCallback((updates) => {
    setData(prev => {
      const next = {...prev, ...updates};
      dataRef.current = next;
      clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(() => {
        syncTimer.current = null;
        const base = prevDataRef.current || {};

        // Write all changes to the active group
        syncToFirestore(activeGroupId, base, next)
          .then(() => { prevDataRef.current = next; })
          .catch(console.error);

        // Cross-sync personal diary changes to ALL other groups.
        // Food/exercise/weight/water belongs to the user, not the group —
        // they should never have to log the same thing twice.
        const changedDiaryKeys = DIARY_KEYS.filter(k => k in updates);
        if (changedDiaryKeys.length > 0) {
          const otherGroupIds = userGroupsRef.current
            .filter(g => g.id !== activeGroupId)
            .map(g => g.id);
          if (otherGroupIds.length > 0) {
            crossSyncDiary(otherGroupIds, base, next, changedDiaryKeys, activeUserRef.current?.id)
              .catch(console.error);
          }
        }
      }, 400);
      return next;
    });
  }, [activeGroupId]);

  // ── Switch group ─────────────────────────────────────────────────────
  const handleSwitchGroup = useCallback(async (groupId) => {
    // Flush any pending local changes for the current group BEFORE clearing state
    clearTimeout(syncTimer.current);
    syncTimer.current = null;
    const currentData = dataRef.current;
    const currentGroupId = activeGroupId; // captured before state change
    if (currentGroupId && currentData && prevDataRef.current) {
      syncToFirestore(currentGroupId, prevDataRef.current, currentData).catch(console.error);
    }

    // Update the ref SYNCHRONOUSLY so onSnapshot guards fire immediately
    activeGroupIdRef.current = groupId;

    // Now clear state — loading screen renders synchronously on next frame
    prevDataRef.current = null;
    dataRef.current     = null;
    setData(null);
    setActiveUser(null);
    setActiveGroupId(groupId);
    setAuthStage('loadingGroup'); // must be before any await

    // Refresh the groups list in the background
    try {
      const userDoc = await getDoc(doc(db, 'users', authUser.uid));
      const groupIds = userDoc.exists() ? (userDoc.data().groups || []) : [];
      const groupDocs = await Promise.all(groupIds.map(id => getDoc(doc(db, 'groups', id))));
      setUserGroups(groupDocs.filter(d => d.exists()).map(d => ({id: d.id, ...d.data()})));
    } catch(e) { console.warn('Could not refresh group list:', e); }
  }, [authUser]);

  // ── Group created / joined ───────────────────────────────────────────
  const handleGroupReady = useCallback(async (groupId) => {
    setGroupFlow(null);

    // Copy profile and ALL existing diary entries into the new group so the
    // user's history is immediately available without any manual re-entry
    if (activeUser) {
      try {
        await setDoc(doc(db, 'groups', groupId, 'profiles', authUser.uid), {
          ...activeUser, googleEmail: authUser.email, id: authUser.uid,
        });
      } catch(e) { console.warn('Could not copy profile:', e); }

      const currentData = dataRef.current;
      if (currentData) {
        try {
          // Pass empty base so EVERYTHING is treated as new (full write)
          await crossSyncDiary([groupId], {}, currentData, DIARY_KEYS, authUser.uid);
        } catch(e) { console.warn('Could not copy diary to new group:', e); }
      }
    }

    // Refresh the user's group list
    try {
      const userDoc = await getDoc(doc(db, 'users', authUser.uid));
      const groupIds = userDoc.exists() ? (userDoc.data().groups || []) : [];
      const groupDocs = await Promise.all(groupIds.map(id => getDoc(doc(db, 'groups', id))));
      setUserGroups(groupDocs.filter(d=>d.exists()).map(d=>({id:d.id,...d.data()})));
    } catch {}

    setActiveGroupId(groupId);
    setAuthStage('loadingGroup');
  }, [authUser, activeUser]);

  // ── Sign in / out ───────────────────────────────────────────────────
  // Raw popup caller — no async wrapper so browser keeps user-gesture context for the popup
  const handleSignIn = () => signInWithPopup(auth, googleProvider);
  const handleEmailSignIn = async (email, password) => {
    await signInWithEmailAndPassword(auth, email, password);
  };
  const handleEmailSignUp = async (email, password) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };
  const handlePasswordReset = async (email) => {
    await sendPasswordResetEmail(auth, email);
  };
  const handleSignOut = () => signOut(auth);

  // ── New user profile save ────────────────────────────────────────────
  const handleNewUserComplete = async (profile) => {
    setSavingProfile(true); setProfileErr('');
    try {
      const fullProfile = {
        ...profile, googleEmail: authUser.email,
        id: authUser.uid, createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'groups', activeGroupId, 'profiles', authUser.uid), fullProfile);
      const newData = {
        ...(data||{}),
        users:           [...((data||{}).users||[]), fullProfile],
        foodEntries:     (data||{}).foodEntries     || [],
        exerciseEntries: (data||{}).exerciseEntries || [],
        weightEntries:   (data||{}).weightEntries   || [],
        waterEntries:    (data||{}).waterEntries    || [],
        customFoods:     (data||{}).customFoods     || [],
        savedRecipes:    (data||{}).savedRecipes    || [],
        favorites:       (data||{}).favorites       || [],
        adminPasscode:   (data||{}).adminPasscode   || null,
        anthropicKey:    (data||{}).anthropicKey    || '',
      };
      setData(newData); prevDataRef.current = newData;
      setActiveUser(fullProfile); setAuthStage('allowed');
    } catch(e) {
      setProfileErr(`Could not save your profile: ${e.message}`);
    } finally { setSavingProfile(false); }
  };

  // ── Global styles ────────────────────────────────────────────────────
  const styles = `
    * { box-sizing: border-box; }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    input[type=range] { -webkit-appearance: none; height: 6px; background: #334155; border-radius: 6px; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; cursor: pointer; }
    input[type=date]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
  `;

  // ── Render ───────────────────────────────────────────────────────────
  if (authStage === 'loading' || authStage === 'loadingGroup' || dataLoading || (authStage === 'allowed' && !data)) return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <style>{styles}</style>
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500 flex items-center justify-center mx-auto mb-4 animate-pulse">
          <Apple size={32} className="text-white"/>
        </div>
        <p className="text-slate-400">
          {authStage === 'loadingGroup' ? 'Loading group…' : 'Loading NutriLog…'}
        </p>
      </div>
    </div>
  );

  if (authStage === 'signedOut') return (
    <><style>{styles}</style>
    <LoginScreen
      onSignIn={handleSignIn}
      onEmailSignIn={handleEmailSignIn}
      onEmailSignUp={handleEmailSignUp}
      onPasswordReset={handlePasswordReset}/></>
  );

  // ── No group yet ─────────────────────────────────────────────────────
  if (authStage === 'noGroup' || (authStage === 'groupPicker' && groupFlow)) {
    if (groupFlow === 'create') return (
      <><style>{styles}</style>
      <CreateGroupScreen authUser={authUser}
        onComplete={handleGroupReady} onBack={()=>setGroupFlow(null)}/></>
    );
    if (groupFlow === 'join') return (
      <><style>{styles}</style>
      <JoinGroupScreen authUser={authUser}
        onComplete={handleGroupReady} onBack={()=>setGroupFlow(null)}/></>
    );
    if (groupFlow === 'migrate') return (
      <><style>{styles}</style>
      <MigrateScreen authUser={authUser}
        onComplete={handleGroupReady} onBack={()=>setGroupFlow(null)}/></>
    );
    return (
      <><style>{styles}</style>
      <NoGroupScreen
        hasOldData={hasOldData}
        onCreate={()=>setGroupFlow('create')}
        onJoin={()=>setGroupFlow('join')}
        onImport={()=>setGroupFlow('migrate')}/></>
    );
  }

  // ── Group picker ─────────────────────────────────────────────────────
  if (authStage === 'groupPicker') return (
    <><style>{styles}</style>
    <GroupPickerScreen authUser={authUser} userGroups={userGroups}
      onSelect={gid => handleSwitchGroup(gid)}
      onCreateGroup={() => setGroupFlow('create')}
      onJoinGroup={() => setGroupFlow('join')}/></>
  );

  // ── New user (in group but no profile) ───────────────────────────────
  if (authStage === 'newUser') return (
    <div className="min-h-screen bg-slate-900 text-white">
      <style>{styles}</style>
      {profileErr && (
        <div className="fixed top-4 left-0 right-0 flex justify-center z-50 px-4">
          <div className="bg-red-500 text-white rounded-2xl px-4 py-3 flex items-center gap-2 shadow-xl max-w-sm w-full">
            <AlertCircle size={16} className="flex-shrink-0"/>
            <p className="text-sm">{profileErr}</p>
          </div>
        </div>
      )}
      {savingProfile && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-800 rounded-2xl px-6 py-4 flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"/>
            <p className="text-white font-semibold">Saving your profile…</p>
          </div>
        </div>
      )}
      <UserEditorModal user={null} isNew={true} fullPage={true}
        onSave={handleNewUserComplete} onClose={()=>{}}/>
    </div>
  );

  // ── Group flow triggered from within the app (e.g. Settings) ────────
  if (authStage === 'allowed' && groupFlow) {
    if (groupFlow === 'create') return (
      <><style>{styles}</style>
      <CreateGroupScreen authUser={authUser}
        onComplete={handleGroupReady} onBack={()=>setGroupFlow(null)}/></>
    );
    if (groupFlow === 'join') return (
      <><style>{styles}</style>
      <JoinGroupScreen authUser={authUser}
        onComplete={handleGroupReady} onBack={()=>setGroupFlow(null)}/></>
    );
  }

  // ── Fully allowed ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <style>{styles}</style>
      <div className="max-w-md mx-auto relative min-h-screen flex flex-col">
        <div className="flex-1 overflow-auto pb-20">
          {activeTab==='diary' && (
            <DiaryPage data={data} updateData={updateData}
              activeUser={activeUser} setActiveUser={setActiveUser}
              dateMode={dateMode} setDateMode={setDateMode}
              selectedDate={selectedDate} setSelectedDate={setSelectedDate}
              customStart={customStart} setCustomStart={setCustomStart}
              customEnd={customEnd} setCustomEnd={setCustomEnd}
              groupName={data?.groupName || ''}
              hasMultipleGroups={userGroups.length > 1}
              onSwitchGroup={() => setAuthStage('groupPicker')}/>
          )}
          {activeTab==='reports'  && <ReportsPage data={data}/>}
          {activeTab==='chat'     && <AIChatPage data={data} updateData={updateData} activeUser={activeUser}/>}
          {activeTab==='settings' && (
            <SettingsPage data={data} updateData={updateData}
              onSignOut={handleSignOut} authUser={authUser}
              activeUser={activeUser}
              activeGroupId={activeGroupId} userGroups={userGroups}
              onSwitchGroup={handleSwitchGroup}
              onJoinGroup={() => setGroupFlow('join')}
              onCreateGroup={() => setGroupFlow('create')}/>
          )}
        </div>
        <BottomNav activeTab={activeTab} setActiveTab={setActiveTab}/>
      </div>
    </div>
  );
}
