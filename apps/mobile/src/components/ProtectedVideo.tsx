import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';

import { authorizedSource } from '../api/client';

export function ProtectedVideo({ path }: { path: string }) {
  const player = useVideoPlayer(null);
  useEffect(() => {
    let active = true;
    void authorizedSource(path).then((source) => { if (active) return player.replaceAsync(source); }).catch(() => undefined);
    return () => { active = false; };
  }, [path, player]);
  return <VideoView player={player} nativeControls contentFit="contain" style={styles.video} />;
}

const styles = StyleSheet.create({ video: { width: '100%', aspectRatio: 1, backgroundColor: '#111111', borderRadius: 18 } });
