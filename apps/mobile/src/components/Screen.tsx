import type { ComponentRef, PropsWithChildren, ReactNode, RefObject } from 'react';
import { ScrollView, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, layout } from '../theme';

export function Screen({ children, scrollRef, overlay, onScroll }: PropsWithChildren<{ scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>; overlay?: ReactNode; onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void }>) {
  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} onScroll={onScroll} scrollEventThrottle={200} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
      {overlay}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: layout.page, paddingTop: 10, paddingBottom: 40 },
});
