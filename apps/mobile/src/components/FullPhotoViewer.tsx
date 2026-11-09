import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProtectedImage } from './ProtectedImage';
import { colors } from '../theme';

export function FullPhotoViewer({ mediaId, sourcePath, onClose }: { mediaId: string | null; sourcePath?: string | null; onClose: () => void }) {
  const path = sourcePath ?? (mediaId ? `/media/${mediaId}/preview` : null);
  return <Modal visible={!!path} animationType="fade" onRequestClose={onClose}>
    <SafeAreaView style={styles.viewer} edges={['top', 'bottom']}>
      <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="Закрыть фотографию" onPress={onClose} style={styles.close}><Ionicons name="close" size={26} color={colors.white} /></Pressable></View>
      {path ? <ProtectedImage path={path} resizeMode="contain" style={styles.photo} /> : null}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: '#111111' },
  header: { height: 52, alignItems: 'flex-end', paddingHorizontal: 14 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  photo: { width: '100%', flex: 1 },
});
