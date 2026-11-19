import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet } from 'react-native';

import { colors } from '../theme';

export function StudioRule() {
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let active = true;
    let changed = false;
    const finish = () => { progress.stopAnimation(); progress.setValue(1); };
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', () => { changed = true; finish(); });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!active || reduced || changed) return;
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }).catch(() => {});
    return () => { active = false; sub.remove(); progress.stopAnimation(); };
  }, [progress]);
  return <Animated.View accessible={false} style={[styles.rule, { opacity: progress, transform: [{ scaleX: progress }] }]} />;
}

const styles = StyleSheet.create({
  rule: { width: 64, height: 2, marginTop: 14, backgroundColor: colors.honey, alignSelf: 'center' },
});
