/**
 * My Workplace — the Expo Go client for the portal's mobile contract.
 *
 * First build: sign in, see the technician's job queue, open a job's
 * proof-of-work gallery and attach a capture, see the van's custody holdings,
 * and read payslips behind the same re-authentication the contract requires.
 *
 * Deliberately dependency-light (no navigation library, no state library): the
 * point of this pass is to prove the contract on a phone, not to grow a second
 * app framework. Everything it calls exists under `/api/v1` today.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import {
  ApiError,
  apiBase,
  evidenceFor,
  jobs,
  login,
  payslips,
  profile,
  reAuth,
  stock,
  uploadEvidence,
  workplaceBootstrap,
  type Holding,
  type WorkOrder,
} from './src/api';

type Tab = 'jobs' | 'stock' | 'payslips' | 'profile';

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const stamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const messageOf = (err: unknown) =>
  err instanceof ApiError ? `${err.code ? `[${err.code}] ` : ''}${err.message}` : String((err as any)?.message || err);

export default function App() {
  const [session, setSession] = useState<{ token: string; user: any } | null>(null);
  const [tab, setTab] = useState<Tab>('jobs');
  const [job, setJob] = useState<WorkOrder | null>(null);

  if (!session) {
    return <LoginScreen onSignedIn={(next) => setSession(next)} />;
  }

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>My Workplace</Text>
          <Text style={styles.headerSub}>
            {session.user?.employeeName || session.user?.email} · {session.user?.role}
          </Text>
        </View>
        <Pressable onPress={() => setSession(null)} style={styles.ghostButton}>
          <Text style={styles.ghostButtonText}>Sign out</Text>
        </Pressable>
      </View>

      {job ? (
        <EvidenceScreen token={session.token} job={job} onBack={() => setJob(null)} />
      ) : (
        <View style={{ flex: 1 }}>
          {tab === 'jobs' && <JobsScreen token={session.token} onOpenJob={setJob} />}
          {tab === 'stock' && <StockScreen token={session.token} />}
          {tab === 'payslips' && <PayslipsScreen token={session.token} />}
          {tab === 'profile' && <ProfileScreen token={session.token} />}
        </View>
      )}

      {!job && (
        <View style={styles.tabBar}>
          {(
            [
              ['jobs', 'Jobs'],
              ['stock', 'My stock'],
              ['payslips', 'Payslips'],
              ['profile', 'Profile'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <Pressable key={id} onPress={() => setTab(id)} style={styles.tabButton}>
              <Text style={[styles.tabLabel, tab === id && styles.tabLabelActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (next: { token: string; user: any }) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const next = await login(email.trim(), password);
      onSignedIn({ token: next.accessToken, user: next });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
        <Text style={styles.title}>My Workplace</Text>
        <Text style={styles.muted}>
          The portal on {apiBase}. Sign in with the same account you use on the web.
        </Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor="#64748b"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor="#64748b"
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable onPress={submit} disabled={busy || !email || !password} style={styles.primaryButton}>
          {busy ? <ActivityIndicator color="#0f172a" /> : <Text style={styles.primaryButtonText}>Sign in</Text>}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await loader());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run, tick]);

  return { data, error, loading, reload: () => setTick((value) => value + 1) };
}

function JobsScreen({ token, onOpenJob }: { token: string; onOpenJob: (job: WorkOrder) => void }) {
  const { data, error, loading, reload } = useLoad(() => jobs(token), [token]);

  return (
    <FlatList
      data={data?.jobs || []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor="#94a3b8" />}
      ListHeaderComponent={
        <View style={{ gap: 6, marginBottom: 4 }}>
          <Text style={styles.sectionTitle}>My jobs</Text>
          <Text style={styles.muted}>
            {data ? `${data.count} open or assigned visit${data.count === 1 ? '' : 's'}` : 'Loading…'}
          </Text>
          {!!error && <Text style={styles.error}>{error}</Text>}
        </View>
      }
      ListEmptyComponent={
        !loading && !error ? <Text style={styles.muted}>No open jobs right now.</Text> : undefined
      }
      renderItem={({ item }) => (
        <Pressable style={styles.card} onPress={() => onOpenJob(item)}>
          <Text style={styles.cardTitle}>{item.workOrderNo}</Text>
          <Text style={styles.cardLine}>{item.customerName || item.customerId}</Text>
          <Text style={styles.cardMeta}>
            {item.kind} · {item.status} · {item.scheduledDateAD}
          </Text>
          <Text style={styles.cardLink}>Proof of work →</Text>
        </Pressable>
      )}
    />
  );
}

function EvidenceScreen({ token, job, onBack }: { token: string; job: WorkOrder; onBack: () => void }) {
  const { data, error, loading, reload } = useLoad(() => evidenceFor(token, job.id), [token, job.id]);
  const [notice, setNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [busy, setBusy] = useState(false);

  const attach = async () => {
    setNotice('');
    setUploadError('');
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.6,
    });
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];
    if (!asset.base64) {
      setUploadError('The picker returned no bytes for that image. Try another photo.');
      return;
    }
    const byteSize = Math.floor((asset.base64.length * 3) / 4);
    if (byteSize > MAX_EVIDENCE_BYTES) {
      setUploadError(
        `That photo is about ${formatBytes(byteSize)}. One capture is capped at 2 MiB (2,097,152 bytes) — retake it smaller.`
      );
      return;
    }
    setBusy(true);
    try {
      const saved = await uploadEvidence(token, job.id, {
        kind: 'PHOTO',
        contentType: asset.mimeType || 'image/jpeg',
        dataBase64: asset.base64,
        caption: `Captured on ${job.workOrderNo}`,
      });
      setNotice(
        saved.inserted
          ? `Stored ${formatBytes(saved.byteSize)} · SHA-256 ${String(saved.sha256).slice(0, 12)}… · the job now holds ${saved.count} capture${saved.count === 1 ? '' : 's'}.`
          : `Already on file — these exact bytes were stored earlier, so nothing was duplicated. The job still holds ${saved.count}.`
      );
      reload();
    } catch (err) {
      setUploadError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Pressable onPress={onBack}>
        <Text style={styles.cardLink}>← All jobs</Text>
      </Pressable>
      <Text style={styles.sectionTitle}>{job.workOrderNo}</Text>
      <Text style={styles.muted}>
        {job.customerName || job.customerId} · {job.scheduledDateAD}
      </Text>

      {!!error && <Text style={styles.error}>{error}</Text>}
      {!!uploadError && <Text style={styles.error}>{uploadError}</Text>}
      {!!notice && <Text style={styles.ok}>{notice}</Text>}

      <Text style={styles.label}>Captures on this job {data ? `(${data.count})` : ''}</Text>
      {loading && <ActivityIndicator color="#94a3b8" />}
      {!loading && data?.evidence?.length === 0 && (
        <Text style={styles.muted}>No proof stored yet. Attach the photo you took on site.</Text>
      )}
      {(data?.evidence || []).map((row, index) => (
        <View key={row.id || row.evidenceId || index} style={styles.card}>
          <Text style={styles.cardTitle}>
            {row.kind === 'PHOTO' ? 'Photo' : 'Signature'} · {formatBytes(row.byteSize)}
          </Text>
          <Text style={styles.cardMeta}>{stamp(row.capturedAt)}</Text>
          <Text style={styles.cardMeta}>SHA-256 {String(row.sha256).slice(0, 12)}…</Text>
          {!!row.caption && <Text style={styles.cardLine}>{row.caption}</Text>}
        </View>
      ))}

      <Pressable onPress={attach} disabled={busy} style={styles.primaryButton}>
        {busy ? <ActivityIndicator color="#0f172a" /> : <Text style={styles.primaryButtonText}>Attach a photo</Text>}
      </Pressable>
      <Text style={styles.muted}>One capture is capped at 2 MiB. Re-sending the same photo stores nothing twice.</Text>
    </ScrollView>
  );
}

function StockScreen({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(() => stock(token), [token]);
  return (
    <FlatList
      data={data?.holdings || []}
      keyExtractor={(item) => item.productId}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor="#94a3b8" />}
      ListHeaderComponent={
        <View style={{ gap: 6, marginBottom: 4 }}>
          <Text style={styles.sectionTitle}>What I hold</Text>
          <Text style={styles.muted}>
            {data?.vanLocation ? `Van ${data.vanLocation} · ` : ''}
            {data ? `${data.count} product line${data.count === 1 ? '' : 's'}` : 'Loading…'}
          </Text>
          {!!error && <Text style={styles.error}>{error}</Text>}
        </View>
      }
      ListEmptyComponent={
        !loading && !error ? <Text style={styles.muted}>Nothing is issued to you right now.</Text> : undefined
      }
      renderItem={({ item }: { item: Holding }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.productName}</Text>
          <Text style={styles.cardMeta}>{item.sku}</Text>
          <Text style={styles.quantity}>{item.quantity}</Text>
          <Text style={styles.cardMeta}>updated {stamp(item.updatedAt)}</Text>
        </View>
      )}
    />
  );
}

function PayslipsScreen({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [reAuthToken, setReAuthToken] = useState('');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const unlock = async () => {
    setError('');
    setBusy(true);
    try {
      const issued = await reAuth(token, password);
      setReAuthToken(issued.reAuthToken);
      const payload = await payslips(token, issued.reAuthToken);
      setData(payload);
      setPassword('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const rows: any[] = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.payslips || data.data || data.rows || [];
  }, [data]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={styles.sectionTitle}>My payslips</Text>
      <Text style={styles.muted}>
        Payslips are sensitive: the contract asks for the password again and the read is audited.
      </Text>

      {!reAuthToken && (
        <>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Your account password"
            placeholderTextColor="#64748b"
          />
          <Pressable onPress={unlock} disabled={busy || !password} style={styles.primaryButton}>
            {busy ? <ActivityIndicator color="#0f172a" /> : <Text style={styles.primaryButtonText}>Unlock payslips</Text>}
          </Pressable>
        </>
      )}

      {!!error && <Text style={styles.error}>{error}</Text>}

      {reAuthToken && rows.length === 0 && <Text style={styles.muted}>No payslips on file.</Text>}
      {rows.map((row, index) => (
        <View key={row.id || row.month || index} style={styles.card}>
          {Object.entries(row)
            .filter(([key, value]) => typeof value !== 'object' && value !== null && value !== '')
            .slice(0, 6)
            .map(([key, value]) => (
              <Text key={key} style={styles.cardLine}>
                {key}: {String(value)}
              </Text>
            ))}
        </View>
      ))}
    </ScrollView>
  );
}

function ProfileScreen({ token }: { token: string }) {
  const { data, error, loading } = useLoad(() => profile(token), [token]);
  const [bootstrap, setBootstrap] = useState<any>(null);

  useEffect(() => {
    workplaceBootstrap(token)
      .then(setBootstrap)
      .catch(() => setBootstrap(null));
  }, [token]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      <Text style={styles.sectionTitle}>Me</Text>
      {loading && <ActivityIndicator color="#94a3b8" />}
      {!!error && <Text style={styles.error}>{error}</Text>}
      {data &&
        Object.entries(data)
          .filter(([, value]) => typeof value !== 'object' && value !== null && value !== '')
          .map(([key, value]) => (
            <Text key={key} style={styles.cardLine}>
              {key}: {String(value)}
            </Text>
          ))}
      {!!bootstrap && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Workplace</Text>
          <Text style={styles.cardMeta}>pending approvals: {JSON.stringify(bootstrap.pendingApprovals)}</Text>
          <Text style={styles.cardMeta}>shift window: {JSON.stringify(bootstrap.shiftWindow)}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: '#0b1220' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: { color: '#e2e8f0', fontSize: 18, fontWeight: '700' },
  headerSub: { color: '#94a3b8', fontSize: 12 },
  title: { color: '#e2e8f0', fontSize: 26, fontWeight: '800' },
  sectionTitle: { color: '#e2e8f0', fontSize: 17, fontWeight: '700' },
  muted: { color: '#94a3b8', fontSize: 13 },
  label: { color: '#cbd5e1', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 8 },
  input: {
    backgroundColor: '#111827',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e2e8f0',
  },
  card: {
    backgroundColor: '#111827',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 2,
  },
  cardTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  cardLine: { color: '#cbd5e1', fontSize: 13 },
  cardMeta: { color: '#94a3b8', fontSize: 12 },
  cardLink: { color: '#38bdf8', fontSize: 13, fontWeight: '600', marginTop: 6 },
  quantity: { color: '#38bdf8', fontSize: 22, fontWeight: '800' },
  error: { color: '#fca5a5', fontSize: 13 },
  ok: { color: '#6ee7b7', fontSize: 13 },
  primaryButton: {
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: { color: '#0f172a', fontWeight: '800', fontSize: 14 },
  ghostButton: { borderColor: '#1e293b', borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  ghostButtonText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1e293b', paddingVertical: 10 },
  tabButton: { flex: 1, alignItems: 'center' },
  tabLabel: { color: '#64748b', fontSize: 12, fontWeight: '700' },
  tabLabelActive: { color: '#38bdf8' },
});
