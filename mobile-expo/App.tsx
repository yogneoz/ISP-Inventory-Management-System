/**
 * My Workplace — the Expo Go client for the portal's mobile contract.
 *
 * It carries every surface the contract documents for a person on a phone:
 * today (punch, shift, announcements), the job queue with proof of work and
 * completion, attendance history, leave (balance, request, withdraw),
 * approvals, expense claims, van stock, payslips, documents, the audited half
 * of the profile and its contact details.
 *
 * Deliberately dependency-light: no navigation library, no state library. The
 * point of this client is to prove the contract on a phone, not to grow a
 * second app framework. Everything it calls exists under `/api/v1` today.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { logout, registerDevice, type LoginResult, type WorkOrder } from './src/api';
import {
  ApprovalsScreen,
  AttendanceScreen,
  ClaimsScreen,
  HomeScreen,
  JobScreen,
  JobsScreen,
  LeavesScreen,
  LoginScreen,
  MoreScreen,
  PayslipsScreen,
  ProfileScreen,
  SensitiveScreen,
  StockScreen,
  type MoreScreenId,
} from './src/screens';
import { styles } from './src/ui';

type Tab = 'home' | 'jobs' | 'attendance' | 'leaves' | 'more';

const TABS: [Tab, string][] = [
  ['home', 'Today'],
  ['jobs', 'Jobs'],
  ['attendance', 'Attendance'],
  ['leaves', 'Leave'],
  ['more', 'More'],
];

const TITLES: Record<MoreScreenId, string> = {
  stock: 'My stock',
  payslips: 'Payslips',
  approvals: 'Approvals',
  claims: 'Expense claim',
  documents: 'My documents',
  sensitive: 'PAN, SSF, bank',
  profile: 'Profile',
};

interface Session {
  token: string;
  refreshToken: string;
  user: LoginResult;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <WorkplaceApp />
    </SafeAreaProvider>
  );
}

function WorkplaceApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [job, setJob] = useState<WorkOrder | null>(null);
  const [moreScreen, setMoreScreen] = useState<MoreScreenId | null>(null);
  const [jobVersion, setJobVersion] = useState(0);

  const signOut = useCallback(async () => {
    const current = session;
    setSession(null);
    setJob(null);
    setMoreScreen(null);
    setTab('home');
    if (!current) return;
    try {
      await logout(current.token, current.refreshToken);
    } catch {
      // A sign-out that cannot reach the portal still signs the phone out.
    }
  }, [session]);

  if (!session) {
    return (
      <SafeAreaView style={styles.shell}>
        <StatusBar style="light" />
        <LoginScreen
          onSignedIn={(next) => {
            setSession(next);
            // The contract binds the phone to the person at login; registering
            // it here is what a revoked device looks like from the server side.
            void registerDevice(next.token, 'expo-1.0.0').catch(() => undefined);
          }}
        />
      </SafeAreaView>
    );
  }

  const capabilities = session.user.workplaceCapabilities || [];

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>
            {job ? job.workOrderNo : moreScreen ? TITLES[moreScreen] : 'My Workplace'}
          </Text>
          <Text style={styles.headerSub}>
            {session.user.employeeName || session.user.email} · {session.user.role}
          </Text>
        </View>
        {job || moreScreen ? (
          <Pressable
            onPress={() => {
              setJob(null);
              setMoreScreen(null);
            }}
            style={styles.ghostButton}
          >
            <Text style={styles.ghostButtonText}>← Back</Text>
          </Pressable>
        ) : (
          <Pressable onPress={signOut} style={styles.ghostButton}>
            <Text style={styles.ghostButtonText}>Sign out</Text>
          </Pressable>
        )}
      </View>

      <View style={{ flex: 1 }}>
        {job ? (
          <JobScreen
            token={session.token}
            job={job}
            onBack={() => setJob(null)}
            onCompleted={() => setJobVersion((value) => value + 1)}
          />
        ) : moreScreen ? (
          moreScreen === 'stock' ? (
            <StockScreen token={session.token} />
          ) : moreScreen === 'payslips' ? (
            <PayslipsScreen token={session.token} />
          ) : moreScreen === 'approvals' ? (
            <ApprovalsScreen token={session.token} capabilities={capabilities} />
          ) : moreScreen === 'claims' ? (
            <ClaimsScreen token={session.token} />
          ) : moreScreen === 'documents' ? (
            <SensitiveScreen token={session.token} mode="documents" />
          ) : moreScreen === 'sensitive' ? (
            <SensitiveScreen token={session.token} mode="sensitive" />
          ) : (
            <ProfileScreen token={session.token} />
          )
        ) : (
          <>
            {tab === 'home' && (
              <HomeScreen
                token={session.token}
                capabilities={capabilities}
                onOpen={(next) => (next === 'approvals' ? setMoreScreen('approvals') : setTab(next))}
              />
            )}
            {tab === 'jobs' && <JobsScreen key={jobVersion} token={session.token} onOpenJob={setJob} />}
            {tab === 'attendance' && <AttendanceScreen token={session.token} />}
            {tab === 'leaves' && <LeavesScreen token={session.token} />}
            {tab === 'more' && (
              <MoreScreen token={session.token} capabilities={capabilities} onOpen={setMoreScreen} />
            )}
          </>
        )}
      </View>

      {!job && !moreScreen && <TabBar tab={tab} onChange={setTab} />}
    </SafeAreaView>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <View style={styles.tabBar}>
      {TABS.map(([id, label]) => (
        <Pressable key={id} onPress={() => onChange(id)} style={styles.tabButton}>
          <Text style={[styles.tabLabel, tab === id && styles.tabLabelActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
