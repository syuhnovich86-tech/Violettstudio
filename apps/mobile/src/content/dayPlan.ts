/** Move a daily plan entry forward only while it stays on the chosen local day. */
export function fitDailySlot(proposed: Date, earliest: Date, selectedDay: string): Date {
  const result = new Date(Math.max(proposed.getTime(), earliest.getTime()));
  const localDay = `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(result.getTime()) || localDay !== selectedDay) throw new Error('Выберите день, в котором осталось достаточно времени для всех публикаций.');
  return result;
}
