export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 2;
const values = new Map();
export async function getItemAsync(key) { return values.get(key) ?? null; }
export async function setItemAsync(key, value) { values.set(key, value); }
