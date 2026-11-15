import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';
import { yearAtPosition } from '../media/yearNavigation';

/** Jump to a server-backed year, including years outside the loaded pages. */
export function YearRail({ years, selected, onSelect }: { years: number[]; selected?: number; onSelect: (year: number) => void }) {
  const rail = useRef<ComponentRef<typeof View>>(null);
  const top = useRef(0);
  const height = useRef(1);
  const currentIndex = useRef(0);
  const previewRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const latest = useRef({ years, selected, onSelect });
  latest.current = { years, selected, onSelect };
  const responder = useMemo(() => {
    const update = (pageY: number) => {
      const entries = latest.current.years;
      if (!entries.length) return;
      const fraction = Math.max(0, Math.min(1, (pageY - top.current) / height.current));
      const value = yearAtPosition(entries, fraction);
      if (value === undefined) return;
      const index = entries.indexOf(value);
      const changed = currentIndex.current !== index || previewRef.current === null;
      currentIndex.current = index;
      previewRef.current = value;
      setPreview(value);
      if (changed) latest.current.onSelect(value);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => { const pageY = event.nativeEvent.pageY; rail.current?.measureInWindow((_x, y, _w, h) => { top.current = y; height.current = h || 1; update(pageY); }); },
      onPanResponderMove: (event) => update(event.nativeEvent.pageY),
      onPanResponderRelease: () => { previewRef.current = null; setPreview(null); },
      onPanResponderTerminate: () => { previewRef.current = null; setPreview(null); },
    });
  }, []);
  if (years.length < 2) return null;
  const displayed = preview ?? selected;
  const position = displayed === undefined || displayed === null ? 0 : Math.max(0, years.indexOf(displayed)) / (years.length - 1);
  return <View style={styles.outer} pointerEvents="box-none">
    {preview !== null ? <View style={styles.bubble}><Text style={styles.bubbleText}>{preview}</Text></View> : null}
    <View ref={rail} collapsable={false} style={styles.touch} {...responder.panHandlers}
      accessible accessibilityRole="adjustable" accessibilityLabel="Быстрый выбор года" accessibilityValue={{ text: displayed ? String(displayed) : 'Все годы' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => { const index = Math.max(0, selected === undefined ? 0 : years.indexOf(selected)); const next = event.nativeEvent.actionName === 'increment' ? Math.min(years.length - 1, index + 1) : Math.max(0, index - 1); const value = years[next]; if (value !== undefined) onSelect(value); }}>
      <View style={styles.track} /><View style={[styles.thumb, { top: `${position * 100}%` }]} />
    </View>
  </View>;
}
const styles = StyleSheet.create({
  outer: { position: 'absolute', right: 0, top: '33%', height: 220, width: 48, zIndex: 10, flexDirection: 'row', alignItems: 'center' },
  touch: { width: 48, height: '100%', alignItems: 'center', justifyContent: 'center' },
  track: { width: 4, height: '100%', borderRadius: 4, backgroundColor: 'rgba(115, 98, 81, 0.35)' },
  thumb: { position: 'absolute', width: 16, height: 32, marginTop: -16, borderRadius: 8, backgroundColor: colors.gold, borderColor: colors.white, borderWidth: 2 },
  bubble: { position: 'absolute', right: 42, backgroundColor: colors.ink, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleText: { color: colors.white, fontWeight: '800', fontSize: 16 },
});
