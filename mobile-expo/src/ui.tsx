/**
 * The app's small set of primitives. One stylesheet, no UI library: the point of
 * this client is the contract on a phone, and a second design system would only
 * make the screens harder to read against the server's shapes.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from 'react-native';

export const palette = {
  shell: '#0b1220',
  card: '#111827',
  border: '#1e293b',
  text: '#e2e8f0',
  line: '#cbd5e1',
  muted: '#94a3b8',
  accent: '#38bdf8',
  ok: '#6ee7b7',
  danger: '#fca5a5',
  warn: '#fbbf24',
};

export const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.shell },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  headerTitle: { color: palette.text, fontSize: 18, fontWeight: '700' },
  headerSub: { color: palette.muted, fontSize: 12 },
  title: { color: palette.text, fontSize: 26, fontWeight: '800' },
  sectionTitle: { color: palette.text, fontSize: 17, fontWeight: '700' },
  subTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  muted: { color: palette.muted, fontSize: 13 },
  line: { color: palette.line, fontSize: 13 },
  label: { color: palette.line, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 8 },
  input: {
    backgroundColor: palette.card,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: palette.text,
  },
  card: {
    backgroundColor: palette.card,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 3,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { color: palette.text, fontSize: 15, fontWeight: '700' },
  cardLine: { color: palette.line, fontSize: 13 },
  meta: { color: palette.muted, fontSize: 12 },
  link: { color: palette.accent, fontSize: 13, fontWeight: '600', marginTop: 6 },
  big: { color: palette.accent, fontSize: 24, fontWeight: '800' },
  error: { color: palette.danger, fontSize: 13 },
  ok: { color: palette.ok, fontSize: 13 },
  warn: { color: palette.warn, fontSize: 13 },
  primaryButton: {
    backgroundColor: palette.text,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: { color: palette.shell, fontWeight: '800', fontSize: 14 },
  ghostButton: { borderColor: palette.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  ghostButtonText: { color: palette.line, fontSize: 12, fontWeight: '600' },
  dangerButton: { borderColor: '#7f1d1d', borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6 },
  dangerButtonText: { color: palette.danger, fontSize: 12, fontWeight: '700' },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  chipActive: { backgroundColor: palette.accent, borderColor: palette.accent },
  chipTextActive: { color: palette.shell },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: palette.border, paddingVertical: 10 },
  tabButton: { flex: 1, alignItems: 'center' },
  tabLabel: { color: '#64748b', fontSize: 12, fontWeight: '700' },
  tabLabelActive: { color: palette.accent },
  divider: { height: 1, backgroundColor: palette.border, marginVertical: 8 },
});

export const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={styles.card}>{children}</View>
);

export const ScreenTitle: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <View style={{ gap: 4 }}>
    <Text style={styles.sectionTitle}>{children}</Text>
    {!!hint && <Text style={styles.muted}>{hint}</Text>}
  </View>
);

export const KeyValue: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <View style={styles.row}>
    <Text style={styles.meta}>{label}</Text>
    <Text style={styles.line}>{value}</Text>
  </View>
);

export const Badge: React.FC<{ text: string; active?: boolean }> = ({ text, active }) => (
  <View style={[styles.chip, active && styles.chipActive]}>
    <Text style={[styles.chipText, active && styles.chipTextActive]}>{text}</Text>
  </View>
);

export const Field: React.FC<{
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboard?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences';
}> = ({ label, value, onChangeText, placeholder, secure, keyboard, autoCapitalize }) => (
  <View style={{ gap: 4 }}>
    {!!label && <Text style={styles.label}>{label}</Text>}
    <TextInput
      style={styles.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#64748b"
      secureTextEntry={secure}
      keyboardType={keyboard}
      autoCapitalize={autoCapitalize || 'none'}
    />
  </View>
);

export const Button: React.FC<{ title: string; onPress: () => void; disabled?: boolean; busy?: boolean }> = ({
  title,
  onPress,
  disabled,
  busy,
}) => (
  <Pressable onPress={onPress} disabled={disabled || busy} style={[styles.primaryButton, (disabled || busy) && { opacity: 0.5 }]}>
    {busy ? <ActivityIndicator color={palette.shell} /> : <Text style={styles.primaryButtonText}>{title}</Text>}
  </Pressable>
);

export const SmallButton: React.FC<{ title: string; onPress: () => void; danger?: boolean; disabled?: boolean }> = ({
  title,
  onPress,
  danger,
  disabled,
}) => (
  <Pressable onPress={onPress} disabled={disabled} style={[danger ? styles.dangerButton : styles.ghostButton, disabled && { opacity: 0.5 }]}>
    <Text style={danger ? styles.dangerButtonText : styles.ghostButtonText}>{title}</Text>
  </Pressable>
);

export const Notice: React.FC<{ error?: string; ok?: string; warn?: string }> = ({ error, ok, warn }) => (
  <>
    {!!error && <Text style={styles.error}>{error}</Text>}
    {!!warn && <Text style={styles.warn}>{warn}</Text>}
    {!!ok && <Text style={styles.ok}>{ok}</Text>}
  </>
);

export const Loader: React.FC<{ show: boolean }> = ({ show }) => (show ? <ActivityIndicator color={palette.muted} /> : null);

/** A scrollable screen body with the shared padding and a pull-to-refresh hook. */
export const Body: React.FC<{ children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }> = ({
  children,
  refreshing,
  onRefresh,
}) => (
  <ScrollView
    contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
    refreshControl={
      onRefresh ? (
        <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={palette.muted} />
      ) : undefined
    }
  >
    {children}
  </ScrollView>
);
