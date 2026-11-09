import { useEffect, useState } from 'react';
import { Image, type ImageResizeMode, type ImageStyle, StyleSheet, View } from 'react-native';

import { authorizedSource } from '../api/client';
import { colors } from '../theme';

export function ProtectedImage({ path, style, resizeMode = 'cover' }: { path: string; style?: ImageStyle; resizeMode?: ImageResizeMode }) {
  const [source, setSource] = useState<{ uri: string; headers?: { Authorization: string } }>();
  useEffect(() => { let active = true; void authorizedSource(path).then((value) => { if (active) setSource(value); }); return () => { active = false; }; }, [path]);
  if (!source) return <View style={[styles.placeholder, style]} />;
  return <Image source={source} resizeMode={resizeMode} style={style} />;
}

const styles = StyleSheet.create({ placeholder: { backgroundColor: colors.creamStrong } });
