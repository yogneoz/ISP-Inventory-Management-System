/**
 * The workplace screens. Each one reads a documented mobile route and renders
 * the shape the server actually sends — no screen invents a number, and every
 * write goes through the same service the web page uses.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import {
  ApiError,
  apiBase,
  approvals as fetchApprovals,
  attendance as fetchAttendance,
  cancelLeave,
  claimById,
  completeJob,
  decideApproval,
  documents as fetchDocuments,
  evidenceFor,
  jobs as fetchJobs,
  leaves as fetchLeaves,
  login,
  payslips as fetchPayslips,
  profile as fetchProfile,
  punch,
  reAuth,
  requestLeave,
  sensitiveProfile,
  stock as fetchStock,
  submitClaim,
  updateContact,
  uploadEvidence,
  workplaceBootstrap,
  type ApprovalsPayload,
  type AttendancePayload,
  type BootstrapPayload,
  type EvidenceRow,
  type Holding,
  type LeaveBalance,
  type LeaveRequest,
  type LoginResult,
  type WorkOrder,
} from './api';
import { Badge, Body, Button, Card, Field, KeyValue, Loader, Notice, ScreenTitle, SmallButton, styles } from './ui';

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const stamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const todayAD = () => new Date().toISOString().slice(0, 10);

const messageOf = (err: unknown) =>
  err instanceof ApiError ? `${err.code ? `[${err.code}] ` : ''}${err.message}` : String((err as any)?.message || err);

const money = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? `NPR ${amount.toLocaleString()}` : String(value ?? '—');
};

/** One read per screen, with the same reload affordance everywhere. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
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

export function LoginScreen({ onSignedIn }: { onSignedIn: (next: { token: string; refreshToken: string; user: LoginResult }) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const next = await login(email.trim(), password);
      onSignedIn({ token: next.accessToken, refreshToken: next.refreshToken, user: next });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body>
      <Text style={styles.title}>My Workplace</Text>
      <Text style={styles.muted}>The portal on {apiBase}. Sign in with the same account you use on the web.</Text>
      <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboard="email-address" />
      <Field label="Password" value={password} onChangeText={setPassword} placeholder="••••••••" secure />
      <Notice error={error} />
      <Button title="Sign in" onPress={submit} disabled={!email || !password} busy={busy} />
    </Body>
  );
}

/** A small capability gate: a screen the caller cannot use says so, once. */
const needs = (capabilities: string[] | undefined, name: string) => !capabilities || capabilities.includes(name);

export function HomeScreen({
  token,
  capabilities,
  onOpen,
}: {
  token: string;
  capabilities: string[];
  onOpen: (tab: 'jobs' | 'attendance' | 'leaves' | 'approvals') => void;
}) {
  const { data, error, loading, reload } = useLoad(() => workplaceBootstrap(token), [token]);
  const [punchBusy, setPunchBusy] = useState('');
  const [punchError, setPunchError] = useState('');
  const [punchNotice, setPunchNotice] = useState('');

  const clock = async (action: 'CLOCK_IN' | 'CLOCK_OUT') => {
    setPunchError('');
    setPunchNotice('');
    setPunchBusy(action);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        throw new Error('Location is off. A punch carries the coordinates the fence is judged against.');
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const saved = await punch(token, {
        action,
        attendanceDateAD: todayAD(),
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy ?? undefined,
      });
      const verdict = String(saved?.verdict || '').toUpperCase();
      setPunchNotice(
        `${action === 'CLOCK_IN' ? 'Clocked in' : 'Clocked out'} at ${saved?.checkInTime || saved?.checkOutTime || 'now'} — ${verdict || 'stored'}${
          saved?.heldReason ? ` (${saved.heldReason})` : ''
        }.`
      );
      reload();
    } catch (err) {
      setPunchError(messageOf(err));
    } finally {
      setPunchBusy('');
    }
  };

  const bootstrap: BootstrapPayload | null = data;
  const clockedIn = String(bootstrap?.punchState || '').toUpperCase() === 'CLOCKED_IN';

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <ScreenTitle hint="Your day, the branch fence and what the office published.">Today</ScreenTitle>
      <Notice error={error} />

      <Card>
        <View style={styles.row}>
          <Text style={styles.cardTitle}>Attendance</Text>
          <Badge text={bootstrap?.punchState || (loading ? 'Loading' : '—')} active={clockedIn} />
        </View>
        <KeyValue label="Shift window" value={bootstrap?.shiftWindow || '—'} />
        <KeyValue
          label="Today"
          value={
            bootstrap?.todayAttendance
              ? `${bootstrap.todayAttendance.status} · in ${bootstrap.todayAttendance.checkInTime || '—'} · out ${bootstrap.todayAttendance.checkOutTime || '—'}`
              : 'No punch yet'
          }
        />
        {!!bootstrap?.geofence?.configured && (
          <KeyValue
            label="Branch fence"
            value={`${bootstrap.geofence.radiusMeters} m around ${bootstrap.geofence.latitude.toFixed(4)}, ${bootstrap.geofence.longitude.toFixed(4)}`}
          />
        )}
        {needs(capabilities, 'attendance.punch') ? (
          <Button
            title={clockedIn ? 'Clock out' : 'Clock in'}
            onPress={() => clock(clockedIn ? 'CLOCK_OUT' : 'CLOCK_IN')}
            busy={Boolean(punchBusy)}
          />
        ) : (
          <Text style={styles.muted}>Your role does not punch from the phone.</Text>
        )}
        <Notice error={punchError} ok={punchNotice} />
      </Card>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable style={[styles.card, { flex: 1 }]} onPress={() => onOpen('jobs')}>
          <Text style={styles.meta}>My visits</Text>
          <Text style={styles.big}>{bootstrap ? bootstrap.needsAttention : '…'}</Text>
          <Text style={styles.muted}>need attention</Text>
        </Pressable>
        <Pressable style={[styles.card, { flex: 1 }]} onPress={() => onOpen('approvals')}>
          <Text style={styles.meta}>Approvals</Text>
          <Text style={styles.big}>{bootstrap ? bootstrap.pendingApprovals : '…'}</Text>
          <Text style={styles.muted}>waiting on me</Text>
        </Pressable>
        <Pressable style={[styles.card, { flex: 1 }]} onPress={() => onOpen('attendance')}>
          <Text style={styles.meta}>Attendance</Text>
          <Text style={styles.big}>{bootstrap ? bootstrap.unreadNotices : '…'}</Text>
          <Text style={styles.muted}>unread notices</Text>
        </Pressable>
      </View>

      <Card>
        <Text style={styles.cardTitle}>Van</Text>
        <Text style={styles.cardLine}>{bootstrap?.vanLocation ? `Stock location ${bootstrap.vanLocation}` : 'No van assigned'}</Text>
        <KeyValue label="Needs attention" value={String(bootstrap?.needsAttention ?? 0)} />
      </Card>

      <ScreenTitle hint="Published by the office, newest first.">Announcements</ScreenTitle>
      {loading && <Loader show />}
      {(bootstrap?.announcements || []).map((item) => (
        <Card key={item.id}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            {item.isUrgent && <Badge text="URGENT" active />}
          </View>
          <Text style={styles.cardLine}>{item.summary}</Text>
          <Text style={styles.meta}>
            {item.category} · {stamp(item.publishedAt)}
          </Text>
        </Card>
      ))}
      {!loading && !error && (bootstrap?.announcements || []).length === 0 && (
        <Text style={styles.muted}>Nothing published this month.</Text>
      )}
    </Body>
  );
}

export function JobsScreen({ token, onOpenJob }: { token: string; onOpenJob: (job: WorkOrder) => void }) {
  const { data, error, loading, reload } = useLoad(() => fetchJobs(token), [token]);

  return (
    <FlatList
      data={data?.jobs || []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListHeaderComponent={
        <View style={{ gap: 6, marginBottom: 4 }}>
          <Text style={styles.sectionTitle}>My jobs</Text>
          <Text style={styles.muted}>
            {data ? `${data.count} open or assigned visit${data.count === 1 ? '' : 's'}` : 'Loading…'}
          </Text>
          <Notice error={error} />
        </View>
      }
      ListEmptyComponent={!loading && !error ? <Text style={styles.muted}>No open jobs right now.</Text> : undefined}
      renderItem={({ item }) => (
        <Pressable style={styles.card} onPress={() => onOpenJob(item)}>
          <Text style={styles.cardTitle}>{item.workOrderNo}</Text>
          <Text style={styles.cardLine}>{item.customerName || item.customerId}</Text>
          <Text style={styles.meta}>
            {item.kind} · {item.status} · {item.scheduledDateAD}
          </Text>
          <Text style={styles.link}>Proof of work →</Text>
        </Pressable>
      )}
    />
  );
}

export function JobScreen({
  token,
  job,
  onBack,
  onCompleted,
}: {
  token: string;
  job: WorkOrder;
  onBack: () => void;
  onCompleted: () => void;
}) {
  const { data, error, loading, reload } = useLoad(() => evidenceFor(token, job.id), [token, job.id]);
  const [notice, setNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [completing, setCompleting] = useState(false);
  const [completeNotice, setCompleteNotice] = useState('');
  const [installSerial, setInstallSerial] = useState('');
  // The van's whole units: a CPE carried for this visit is what the closing
  // screen installs, so the serial is chosen from the units the server says are
  // in this technician's custody — never typed from memory.
  const van = useLoad(() => fetchStock(token), [token]);
  const heldForJob = (van.data?.assets || []).filter((asset) => asset.workOrderId === job.id);

  const attach = async () => {
    setNotice('');
    setUploadError('');
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.6 });
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

  const complete = async () => {
    setCompleteNotice('');
    if (!notes.trim()) {
      setCompleteNotice('Say what was done on site — the completion note is what the office reads.');
      return;
    }
    setCompleting(true);
    try {
      const result = await completeJob(token, job.id, {
        baseVersion: job.rowVersion,
        notes: notes.trim(),
        serialUsed: installSerial || undefined,
      });
      const installed = result.installedAssets || [];
      setCompleteNotice(
        `${result.resultStatus}: ${result.message}` +
          (installed.length
            ? ` ${installed
                .map(
                  (row) =>
                    `Installed ${row.tagNumber} (${row.deviceSerial}) at ${row.customerName}; warranty starts ${row.warrantyStartDateAD}.`
                )
                .join(' ')}`
            : '')
      );
      onCompleted();
    } catch (err) {
      setCompleteNotice(messageOf(err));
    } finally {
      setCompleting(false);
    }
  };

  const done = String(job.status).toUpperCase() === 'COMPLETED';

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <Pressable onPress={onBack}>
        <Text style={styles.link}>← All jobs</Text>
      </Pressable>
      <Text style={styles.sectionTitle}>
        {job.workOrderNo} <Text style={styles.meta}>v{job.rowVersion}</Text>
      </Text>
      <Text style={styles.muted}>
        {job.customerName || job.customerId} · {job.scheduledDateAD} · {job.status}
      </Text>
      {!!job.notes && (
        <Card>
          <Text style={styles.cardTitle}>Office note</Text>
          <Text style={styles.cardLine}>{job.notes}</Text>
        </Card>
      )}

      <Notice error={error} />
      <Notice error={uploadError} />
      <Notice ok={notice} />

      <Text style={styles.label}>Captures on this job {data ? `(${data.count})` : ''}</Text>
      <Loader show={loading} />
      {!loading && data?.evidence?.length === 0 && (
        <Text style={styles.muted}>No proof stored yet. Attach the photo you took on site.</Text>
      )}
      {(data?.evidence || []).map((row: EvidenceRow, index: number) => (
        <View key={row.id || row.evidenceId || index} style={styles.card}>
          <Text style={styles.cardTitle}>
            {row.kind === 'PHOTO' ? 'Photo' : 'Signature'} · {formatBytes(row.byteSize)}
          </Text>
          <Text style={styles.meta}>{stamp(row.capturedAt)}</Text>
          <Text style={styles.meta}>SHA-256 {String(row.sha256).slice(0, 12)}…</Text>
          {!!row.caption && <Text style={styles.cardLine}>{row.caption}</Text>}
        </View>
      ))}

      <Button title="Attach a photo" onPress={attach} busy={busy} />
      <Text style={styles.muted}>One capture is capped at 2 MiB. Re-sending the same photo stores nothing twice.</Text>

      <View style={styles.divider} />
      <Text style={styles.label}>Close the visit</Text>
      {done ? (
        <Text style={styles.ok}>This job is already completed.</Text>
      ) : (
        <>
          {heldForJob.length > 0 && (
            <>
              <Text style={styles.label}>Unit to install</Text>
              <Text style={styles.muted}>
                Dispatched for this visit. Pick the unit you mounted and closing the job installs it at the customer,
                starting its warranty on the completion date.
              </Text>
              {heldForJob.map((asset) => {
                const serial = String(asset.deviceSerial || '');
                const chosen = !!serial && installSerial === serial;
                return (
                  <Pressable
                    key={asset.assetId}
                    onPress={() => serial && setInstallSerial(chosen ? '' : serial)}
                    style={styles.card}
                  >
                    <Text style={styles.cardTitle}>
                      {chosen ? '✓ ' : ''}
                      {asset.productName}
                    </Text>
                    <Text style={styles.meta}>
                      Tag {asset.tagNumber} · serial {serial || 'not recorded'}
                    </Text>
                    {!serial && <Text style={styles.meta}>Record the unit serial before it can be installed.</Text>}
                    {!!asset.scheduledDateAD && <Text style={styles.meta}>Visit {asset.scheduledDateAD}</Text>}
                  </Pressable>
                );
              })}
              <Text style={styles.muted}>
                {installSerial
                  ? `Closing the job installs ${installSerial} and leaves your custody.`
                  : 'No unit picked: the job closes without installing anything, and the unit stays with you.'}
              </Text>
            </>
          )}
          <Field label="Completion note" value={notes} onChangeText={setNotes} placeholder="What was done, what was replaced" autoCapitalize="sentences" />
          <Button title="Complete job" onPress={complete} busy={completing} disabled={!notes.trim()} />
          <Text style={styles.muted}>
            The completion carries this phone's copy (v{job.rowVersion}); a job changed elsewhere is refused rather than overwritten.
          </Text>
        </>
      )}
      <Notice error={completeNotice} />
    </Body>
  );
}

export function AttendanceScreen({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(() => fetchAttendance(token), [token]);
  const summary = (data as AttendancePayload | null)?.summary;

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <ScreenTitle
        hint={data ? `${data.windowStartAD} → ${data.windowEndAD} (${data.windowDays} days)` : 'Loading the window…'}
      >
        My attendance
      </ScreenTitle>
      <Notice error={error} />
      {!!summary && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Card>
            <Text style={styles.meta}>Present</Text>
            <Text style={styles.big}>{summary.presentDays}</Text>
          </Card>
          <Card>
            <Text style={styles.meta}>Leave</Text>
            <Text style={styles.big}>{summary.leaveDays}</Text>
          </Card>
          <Card>
            <Text style={styles.meta}>Absent</Text>
            <Text style={styles.big}>{summary.absentDays}</Text>
          </Card>
          <Card>
            <Text style={styles.meta}>OT hrs</Text>
            <Text style={styles.big}>{summary.overtimeHours}</Text>
          </Card>
        </View>
      )}
      <Loader show={loading} />
      {!loading && (data?.records?.length ?? 0) === 0 && <Text style={styles.muted}>No attendance recorded in this window.</Text>}
      {(data?.records || []).map((record) => (
        <Card key={record.id}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>{record.attendanceDateAD}</Text>
            <Badge text={record.status} active={record.status === 'PRESENT'} />
          </View>
          <Text style={styles.cardLine}>
            in {record.checkInTime || '—'} · out {record.checkOutTime || '—'}
            {record.overtimeHours ? ` · ${record.overtimeHours} OT` : ''}
          </Text>
          <Text style={styles.meta}>
            {record.shiftName || 'No shift'} {record.attendanceDateBS ? `· ${record.attendanceDateBS}` : ''}
          </Text>
        </Card>
      ))}
    </Body>
  );
}

export function LeavesScreen({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(() => fetchLeaves(token), [token]);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState('');

  const balances: LeaveBalance[] = data?.balances || [];
  const requests: LeaveRequest[] = data?.requests || [];
  const chosen = leaveTypeId || balances[0]?.leaveTypeId || '';

  const submit = async () => {
    setWriteError('');
    setNotice('');
    setBusy(true);
    try {
      const saved = await requestLeave(token, {
        leaveTypeId: chosen,
        startDateAD: startDate.trim(),
        endDateAD: endDate.trim(),
        reason: reason.trim(),
      });
      setNotice(`${saved.requestNo} submitted: ${saved.startDateAD} → ${saved.endDateAD} (${saved.daysCount} day(s)).`);
      setStartDate('');
      setEndDate('');
      setReason('');
      reload();
    } catch (err) {
      setWriteError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: string) => {
    setWriteError('');
    setNotice('');
    try {
      await cancelLeave(token, id);
      setNotice('Request withdrawn.');
      reload();
    } catch (err) {
      setWriteError(messageOf(err));
    }
  };

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <ScreenTitle hint="Your balances, the requests you filed, and the ones waiting on you.">Leave</ScreenTitle>
      <Notice error={error} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {balances.map((balance) => (
          <Card key={balance.id}>
            <Text style={styles.meta}>{balance.leaveTypeName}</Text>
            <Text style={styles.big}>{balance.remainingDays}</Text>
            <Text style={styles.muted}>of {balance.entitlementDays} days</Text>
          </Card>
        ))}
      </View>

      <Text style={styles.label}>Requests</Text>
      <Loader show={loading} />
      {!loading && requests.length === 0 && <Text style={styles.muted}>No leave requests on file.</Text>}
      {requests.map((request) => (
        <Card key={request.id}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>{request.requestNo}</Text>
            <Badge text={request.status} active={request.status === 'APPROVED'} />
          </View>
          <Text style={styles.cardLine}>
            {request.leaveTypeName} · {request.startDateAD} → {request.endDateAD} · {request.daysCount} day(s)
          </Text>
          {!!request.reason && <Text style={styles.meta}>{request.reason}</Text>}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
            {request.status === 'PENDING' && <SmallButton title="Withdraw" onPress={() => withdraw(request.id)} danger />}
          </View>
        </Card>
      ))}

      <View style={styles.divider} />
      <Text style={styles.label}>Request leave</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {balances.map((balance) => (
          <Pressable key={balance.id} onPress={() => setLeaveTypeId(balance.leaveTypeId)}>
            <Badge text={balance.leaveTypeCode} active={chosen === balance.leaveTypeId} />
          </Pressable>
        ))}
      </View>
      <Field label="From (YYYY-MM-DD)" value={startDate} onChangeText={setStartDate} placeholder="2026-12-10" />
      <Field label="To (YYYY-MM-DD)" value={endDate} onChangeText={setEndDate} placeholder="2026-12-11" />
      <Field label="Reason" value={reason} onChangeText={setReason} placeholder="Why these days" autoCapitalize="sentences" />
      <Button title="Submit request" onPress={submit} disabled={!chosen || !startDate || !endDate} busy={busy} />
      <Notice error={writeError} ok={notice} />
    </Body>
  );
}

export function ApprovalsScreen({ token, capabilities }: { token: string; capabilities: string[] }) {
  const { data, error, loading, reload } = useLoad(() => fetchApprovals(token), [token]);
  const [notice, setNotice] = useState('');
  const [decideError, setDecideError] = useState('');

  const decide = async (kind: 'EXPENSE_CLAIM' | 'PUNCH', id: string, approve: boolean) => {
    setDecideError('');
    setNotice('');
    try {
      const saved = await decideApproval(token, kind, id, approve);
      setNotice(`${kind === 'EXPENSE_CLAIM' ? 'Claim' : 'Punch'} ${saved.status ? saved.status.toLowerCase() : 'decided'}.`);
      reload();
    } catch (err) {
      setDecideError(messageOf(err));
    }
  };

  const payload: ApprovalsPayload | null = data;
  const canApprove = needs(capabilities, 'approve.expense') || needs(capabilities, 'approve.attendance_ot');

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <ScreenTitle hint="Your branch's claims and flagged punches. Nobody approves their own row.">Approvals</ScreenTitle>
      <Notice error={error} />
      <Text style={styles.label}>
        Expense claims {payload ? `(${payload.counts.claims})` : ''}
      </Text>
      <Loader show={loading} />
      {!loading && (payload?.claims.length ?? 0) === 0 && <Text style={styles.muted}>No claims are waiting in this branch.</Text>}
      {(payload?.claims || []).map((claim: any) => (
        <Card key={claim.id}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>{claim.employeeName || claim.employeeId}</Text>
            <Badge text={claim.status} />
          </View>
          <Text style={styles.cardLine}>
            {claim.category} · {money(claim.amount)}
          </Text>
          {!!claim.description && <Text style={styles.meta}>{claim.description}</Text>}
          <Text style={styles.meta}>submitted {stamp(claim.submittedAt)}</Text>
          {canApprove && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <SmallButton title="Approve" onPress={() => decide('EXPENSE_CLAIM', claim.id, true)} />
              <SmallButton title="Reject" onPress={() => decide('EXPENSE_CLAIM', claim.id, false)} danger />
            </View>
          )}
        </Card>
      ))}

      <Text style={styles.label}>
        Flagged punches {payload ? `(${payload.counts.punches})` : ''}
      </Text>
      {!loading && (payload?.punches.length ?? 0) === 0 && <Text style={styles.muted}>No punch needs a supervisor's review.</Text>}
      {(payload?.punches || []).map((row: any) => (
        <Card key={row.id}>
          <Text style={styles.cardTitle}>
            {row.employeeName || row.employeeId} · {row.attendanceDateAd || row.attendanceDateAD}
          </Text>
          <Text style={styles.cardLine}>
            {row.verdict || row.integrityStatus} {row.heldReason ? `· ${row.heldReason}` : ''}
          </Text>
          {canApprove && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
              <SmallButton title="Confirm time" onPress={() => decide('PUNCH', row.id, true)} />
            </View>
          )}
        </Card>
      ))}
      <Notice error={decideError} ok={notice} />
    </Body>
  );
}

export function StockScreen({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(() => fetchStock(token), [token]);
  const holdings = data?.holdings || [];
  const assets = data?.assets || [];
  return (
    <FlatList
      data={holdings}
      keyExtractor={(item) => item.productId}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListHeaderComponent={
        <View style={{ gap: 6, marginBottom: 4 }}>
          <Text style={styles.sectionTitle}>What I hold</Text>
          <Text style={styles.muted}>
            {data?.vanLocation ? `Van ${data.vanLocation} · ` : ''}
            {data
              ? `${holdings.length} product line${holdings.length === 1 ? '' : 's'} · ${assets.length} whole unit${
                  assets.length === 1 ? '' : 's'
                }`
              : 'Loading…'}
          </Text>
          <Notice error={error} />
          {assets.length > 0 && (
            <>
              <Text style={styles.label}>Whole units</Text>
              {assets.map((asset) => (
                <View key={asset.assetId} style={styles.card}>
                  <Text style={styles.cardTitle}>{asset.productName}</Text>
                  <Text style={styles.meta}>
                    Tag {asset.tagNumber} · serial {asset.deviceSerial || 'not recorded'}
                  </Text>
                  {asset.workOrderNo ? (
                    <Text style={styles.meta}>
                      Dispatched for {asset.workOrderNo}
                      {asset.customerName ? ` · ${asset.customerName}` : ''}
                      {asset.scheduledDateAD ? ` · ${asset.scheduledDateAD}` : ''}
                    </Text>
                  ) : (
                    <Text style={styles.meta}>Issued to you, not tied to a visit.</Text>
                  )}
                </View>
              ))}
            </>
          )}
        </View>
      }
      ListEmptyComponent={
        !loading && !error && assets.length === 0 ? (
          <Text style={styles.muted}>Nothing is issued to you right now.</Text>
        ) : undefined
      }
      renderItem={({ item }: { item: Holding }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.productName}</Text>
          <Text style={styles.meta}>{item.sku}</Text>
          <Text style={styles.big}>{item.quantity}</Text>
          <Text style={styles.meta}>updated {stamp(item.updatedAt)}</Text>
        </View>
      )}
    />
  );
}

export function PayslipsScreen({ token }: { token: string }) {
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
      setData(await fetchPayslips(token, issued.reAuthToken));
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
    <Body>
      <ScreenTitle hint="Payslips are sensitive: the contract asks for the password again and the read is audited.">
        My payslips
      </ScreenTitle>
      {!reAuthToken && (
        <>
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="Your account password" secure />
          <Button title="Unlock payslips" onPress={unlock} disabled={!password} busy={busy} />
        </>
      )}
      <Notice error={error} />
      {reAuthToken && rows.length === 0 && <Text style={styles.muted}>No payslips on file.</Text>}
      {rows.map((row, index) => (
        <Card key={row.id || row.periodKey || index}>
          <Text style={styles.cardTitle}>
            {row.periodKey || row.runNo} · {row.status}
          </Text>
          <KeyValue label="Gross" value={money(row.gross)} />
          <KeyValue label="Deductions" value={money(row.totalDeductions ?? row.deductions)} />
          <KeyValue label="Net paid" value={money(row.netPay ?? row.net ?? row.totalNet)} />
          <Text style={styles.meta}>
            {row.runDateAD} · {row.branchName}
          </Text>
        </Card>
      ))}
    </Body>
  );
}

export function ClaimsScreen({ token }: { token: string }) {
  const [category, setCategory] = useState('TRAVEL');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<any>(null);
  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState('');

  const categories = ['TRAVEL', 'MEALS', 'MATERIALS', 'GENERAL'];

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const result = await submitClaim(token, {
        category,
        amount: Number(amount),
        description: description.trim(),
        receiptAttached: true,
      });
      setSaved(result);
      setAmount('');
      setDescription('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const findClaim = async () => {
    setLookupError('');
    try {
      setSaved(await claimById(token, lookup.trim()));
    } catch (err) {
      setLookupError(messageOf(err));
    }
  };

  return (
    <Body>
      <ScreenTitle hint="A claim is submitted, approved by a supervisor, then posted to the ledger outbox.">
        Expense claim
      </ScreenTitle>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {categories.map((entry) => (
          <Pressable key={entry} onPress={() => setCategory(entry)}>
            <Badge text={entry} active={category === entry} />
          </Pressable>
        ))}
      </View>
      <Field label="Amount (NPR)" value={amount} onChangeText={setAmount} placeholder="1250" keyboard="numeric" />
      <Field label="What for" value={description} onChangeText={setDescription} placeholder="Taxi to the customer site" autoCapitalize="sentences" />
      <Button title="Submit claim" onPress={submit} disabled={!amount || !description.trim()} busy={busy} />
      <Notice error={error} />
      {!!saved && (
        <Card>
          <Text style={styles.cardTitle}>{saved.claimId || saved.id}</Text>
          <KeyValue label="Status" value={saved.status} />
          <KeyValue label="Accounting" value={saved.accountingOutboxStatus || '—'} />
          {!!saved.submittedAt && <Text style={styles.meta}>submitted {stamp(saved.submittedAt)}</Text>}
        </Card>
      )}

      <View style={styles.divider} />
      <Text style={styles.label}>Find a claim</Text>
      <Field value={lookup} onChangeText={setLookup} placeholder="demo-expense-001" />
      <Button title="Look it up" onPress={findClaim} disabled={!lookup.trim()} />
      <Notice error={lookupError} />
    </Body>
  );
}

export function SensitiveScreen({ token, mode }: { token: string; mode: 'documents' | 'sensitive' }) {
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
      setData(mode === 'documents' ? await fetchDocuments(token, issued.reAuthToken) : await sensitiveProfile(token, issued.reAuthToken));
      setPassword('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'documents' ? 'My documents' : 'PAN, SSF and bank';
  const hint =
    mode === 'documents'
      ? 'Employment papers, with the expiry the portal tracks.'
      : 'The sensitive half of the profile. Every open is audited as MOBILE_SENSITIVE_VIEW.';

  return (
    <Body>
      <ScreenTitle hint={hint}>{title}</ScreenTitle>
      {!reAuthToken && (
        <>
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="Your account password" secure />
          <Button title="Unlock" onPress={unlock} disabled={!password} busy={busy} />
        </>
      )}
      <Notice error={error} />
      {mode === 'documents' &&
        (data?.documents || []).map((doc: any) => (
          <Card key={doc.id}>
            <View style={styles.row}>
              <Text style={styles.cardTitle}>{doc.title}</Text>
              <Badge text={doc.expiryStatus || doc.docType} active={doc.expiryStatus === 'VALID'} />
            </View>
            <Text style={styles.meta}>
              {doc.docType} · {formatBytes(doc.byteSize)} · expires {doc.expiresOnAD || 'never'}
            </Text>
            {!!doc.notes && <Text style={styles.cardLine}>{doc.notes}</Text>}
          </Card>
        ))}
      {mode === 'documents' && reAuthToken && (data?.documents || []).length === 0 && (
        <Text style={styles.muted}>No documents on file.</Text>
      )}
      {mode === 'sensitive' && !!data && (
        <Card>
          <KeyValue label="PAN" value={data.panNumber || '—'} />
          <KeyValue label="SSF" value={data.ssfNumber || (data.ssfEligible ? 'eligible' : 'not eligible')} />
          <KeyValue label="Bank" value={data.bankName || '—'} />
          <KeyValue label="Account" value={data.bankAccount || '—'} />
          <KeyValue label="Monthly salary" value={money(data.monthlySalary)} />
          <Text style={styles.meta}>read at {stamp(data.viewedAt)}</Text>
        </Card>
      )}
    </Body>
  );
}

export function ProfileScreen({ token }: { token: string }) {
  const { data, error, loading, reload } = useLoad(() => fetchProfile(token), [token]);
  const [phone, setPhone] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState('');

  useEffect(() => {
    if (!data) return;
    setPhone(String(data.personalContact || ''));
    setEmergencyName(String(data.emergencyContactPerson || ''));
    setEmergencyPhone(String(data.emergencyContactNumber || ''));
  }, [data]);

  const save = async () => {
    setNotice('');
    setWriteError('');
    setBusy(true);
    try {
      await updateContact(token, { phone, emergencyContactName: emergencyName, emergencyContactPhone: emergencyPhone });
      setNotice('Contact details updated.');
      reload();
    } catch (err) {
      setWriteError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Body refreshing={loading} onRefresh={reload}>
      <ScreenTitle hint="The everyday card: no PAN, SSF, bank or salary on this screen.">Me</ScreenTitle>
      <Loader show={loading} />
      <Notice error={error} />
      {!!data && (
        <Card>
          <Text style={styles.cardTitle}>{data.name}</Text>
          <Text style={styles.meta}>
            {data.employeeCode} · {data.designation}
          </Text>
          <KeyValue label="Branch" value={data.branchName || data.branchId} />
          <KeyValue label="Department" value={data.department || '—'} />
          <KeyValue label="Work station" value={data.workStation || '—'} />
          <KeyValue label="Joined" value={data.joiningDateAD || '—'} />
          <KeyValue label="Email" value={data.internalEmail || '—'} />
        </Card>
      )}

      <View style={styles.divider} />
      <Text style={styles.label}>Contact details</Text>
      <Field label="Phone" value={phone} onChangeText={setPhone} placeholder="98XXXXXXXX" keyboard="phone-pad" />
      <Field label="Emergency contact" value={emergencyName} onChangeText={setEmergencyName} placeholder="Name" autoCapitalize="sentences" />
      <Field label="Emergency phone" value={emergencyPhone} onChangeText={setEmergencyPhone} placeholder="98XXXXXXXX" keyboard="phone-pad" />
      <Button title="Save contact details" onPress={save} busy={busy} />
      <Notice error={writeError} ok={notice} />
    </Body>
  );
}

/** The "More" hub: everything the bottom bar has no room for. */
export const MoreScreen: React.FC<{
  token: string;
  capabilities: string[];
  onOpen: (screen: MoreScreenId) => void;
}> = ({ token, capabilities, onOpen }) => {
  const entries: { id: MoreScreenId; label: string; hint: string; visible: boolean }[] = [
    { id: 'stock', label: 'My stock', hint: 'The units issued to me', visible: true },
    { id: 'payslips', label: 'Payslips', hint: 'Behind a re-authentication', visible: true },
    {
      id: 'approvals',
      label: 'Approvals',
      hint: 'Claims and punches waiting on me',
      visible: needs(capabilities, 'approve.expense') || needs(capabilities, 'approve.attendance_ot'),
    },
    { id: 'claims', label: 'Expense claim', hint: 'Submit and follow a claim', visible: needs(capabilities, 'claims.submit') },
    { id: 'documents', label: 'My documents', hint: 'Employment papers', visible: needs(capabilities, 'ess.view') },
    { id: 'sensitive', label: 'PAN, SSF, bank', hint: 'The audited half of the profile', visible: needs(capabilities, 'ess.view') },
    { id: 'profile', label: 'Profile', hint: 'Me and my contact details', visible: true },
  ];

  return (
    <Body>
      <ScreenTitle hint="The rest of the workplace, grouped so the bottom bar stays readable.">More</ScreenTitle>
      {entries
        .filter((entry) => entry.visible)
        .map((entry) => (
          <Pressable key={entry.id} style={styles.card} onPress={() => onOpen(entry.id)}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{entry.label}</Text>
                <Text style={styles.muted}>{entry.hint}</Text>
              </View>
              <Text style={styles.link}>›</Text>
            </View>
          </Pressable>
        ))}
      <Text style={styles.meta}>
        Signed in as {capabilities.length} workplace capabilit{capabilities.length === 1 ? 'y' : 'ies'}.
      </Text>
    </Body>
  );
};

export type MoreScreenId = 'stock' | 'payslips' | 'approvals' | 'claims' | 'documents' | 'sensitive' | 'profile';
