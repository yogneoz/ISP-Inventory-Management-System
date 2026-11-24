/**
 * `expo-image-picker` for the mobile render check. Picking is a native sheet, so
 * the stub answers "cancelled" — the screens then do nothing, which is exactly
 * the branch a mount can observe without a device.
 */
export async function launchImageLibraryAsync() {
  return { canceled: true, assets: [] };
}
