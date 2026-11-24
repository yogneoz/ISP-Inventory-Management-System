/**
 * `react-native` for the mobile render check.
 *
 * The mobile client is written against React Native's components, which cannot
 * be evaluated outside a device or a Metro preset. Each component here is a thin
 * host element with the same props contract the screens use — `FlatList` still
 * runs `renderItem`, `ListHeaderComponent` and `ListEmptyComponent`, `TextInput`
 * still reports `onChangeText` — so mounting a screen exercises its real logic
 * (loading, mapping the payload, choosing between rows and the empty state)
 * rather than a mock of the screen itself.
 *
 * `style` is deliberately not forwarded: React DOM would warn about every
 * React-Native-only style key, and this check is about rendered data, not paint.
 */
import React from 'react';

type AnyProps = any;

export const StyleSheet = {
  create: (styles: Record<string, unknown>) => styles,
  flatten: (style: unknown) => style,
  hairlineWidth: 1,
  absoluteFillObject: {},
};

const host = (tag: string) => (props: AnyProps) =>
  React.createElement(tag, { 'data-rn': tag }, props.children);

export const View = host('div');
export const Text = host('span');
export const ScrollView = host('div');

export const Pressable = (props: AnyProps) =>
  React.createElement('div', { 'data-rn': 'Pressable', onClick: props.onPress }, props.children);

export const ActivityIndicator = () => React.createElement('div', { 'data-rn': 'spinner' }, 'spinner');

export const RefreshControl = () => null;

export const TextInput = (props: AnyProps) =>
  React.createElement('input', {
    'data-rn': 'TextInput',
    value: props.value ?? '',
    placeholder: props.placeholder,
    onChange: (event: any) => props.onChangeText?.(event.target.value),
    disabled: props.editable === false,
  });

/** React Native accepts either an element or a component for these slots. */
const slot = (value: any) =>
  value === null || value === undefined
    ? null
    : React.isValidElement(value)
      ? value
      : React.createElement(value);

export function FlatList(props: AnyProps) {
  const data: any[] = props.data || [];
  const rows =
    data.length === 0
      ? slot(props.ListEmptyComponent)
      : data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: props.keyExtractor ? String(props.keyExtractor(item, index)) : String(index) },
            props.renderItem({ item, index })
          )
        );
  return React.createElement('div', { 'data-rn': 'FlatList' }, slot(props.ListHeaderComponent), rows);
}

export const Platform = {
  OS: 'android',
  select: (options: Record<string, unknown>) => options.android ?? options.default,
};
