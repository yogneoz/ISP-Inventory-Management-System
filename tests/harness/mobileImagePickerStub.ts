/**
 * `expo-image-picker` for the mobile render check. Picking is a native sheet, so
 * the default answer is "cancelled" — the branch a mount observes without a
 * device, and the one a stray tap must never turn into an upload.
 *
 * A test that drives the attach flow arms the next answer with `pickerWillReturn`
 * in exactly the shape the real module resolves, then reads what the screen was
 * handed back from `pickerCalls`.
 *
 * The state lives on `globalThis` because the loader can hand the screens and the
 * test separate instances of this stub (the specifier hook and a direct URL import
 * are distinct module records); the phone would share one native module, so the
 * stub has to as well.
 */
export interface PickedAsset {
  uri: string;
  mimeType?: string;
  base64?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface PickResult {
  canceled: boolean;
  assets?: PickedAsset[];
}

const CANCELLED: PickResult = { canceled: true, assets: [] };
const STATE_KEY = Symbol.for('render-check.expo-image-picker');

interface PickerState {
  next: PickResult;
  calls: PickResult[];
}

const state: PickerState = ((globalThis as any)[STATE_KEY] ||= { next: CANCELLED, calls: [] });

/** Every result the screen has been handed, in order. */
export const pickerCalls: PickResult[] = state.calls;

/** Arms the next `launchImageLibraryAsync` answer; one shot, like the real sheet. */
export function pickerWillReturn(result: PickResult): void {
  state.next = result;
}

/** Back to "the user closed the sheet", with the call log cleared. */
export function resetPicker(): void {
  state.next = CANCELLED;
  state.calls.length = 0;
}

export async function launchImageLibraryAsync(_options?: unknown): Promise<PickResult> {
  const answer = state.next;
  state.next = CANCELLED;
  state.calls.push(answer);
  return answer;
}
