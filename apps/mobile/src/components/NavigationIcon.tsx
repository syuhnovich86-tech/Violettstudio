import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '../theme';

export type NavigationIconName = 'calendar' | 'media' | 'add' | 'content' | 'chats' | 'profile';

type Props = { name: NavigationIconName; active?: boolean; size?: number };

export function NavigationIcon({ name, active = false, size = 28 }: Props) {
  const ink = active ? colors.ink : colors.muted;
  const accent = active || name === 'add' ? colors.gold : colors.line;
  const honey = active || name === 'add' ? colors.honey : colors.creamStrong;
  const common = { stroke: ink, strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      {name === 'calendar' ? (
        <>
          <Rect x="11" y="14" width="42" height="39" rx="12" {...common} />
          <Path d="M11 26H53M22 10V19M42 10V19" {...common} />
          <Circle cx="32" cy="39" r="7" fill={honey} stroke={accent} strokeWidth="2" />
          <Path d="M32 35V40L35 42" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : null}
      {name === 'media' ? (
        <>
          <Rect x="10" y="17" width="38" height="34" rx="10" {...common} />
          <Rect x="17" y="11" width="37" height="35" rx="10" fill={colors.cream} {...common} />
          <Circle cx="43" cy="22" r="4" fill={honey} stroke={accent} strokeWidth="2" />
          <Path d="M21 40L29 31L35 37L40 32L50 42" {...common} />
        </>
      ) : null}
      {name === 'add' ? (
        <>
          <Rect x="9" y="18" width="46" height="34" rx="12" {...common} />
          <Path d="M21 18L25 12H39L43 18" {...common} />
          <Circle cx="31" cy="35" r="10" {...common} />
          <Circle cx="31" cy="35" r="4" fill={colors.honey} />
          <Circle cx="50" cy="15" r="9" fill={colors.honey} stroke={colors.gold} strokeWidth="2" />
          <Path d="M50 11V19M46 15H54" stroke={colors.ink} strokeWidth="2.4" strokeLinecap="round" />
        </>
      ) : null}
      {name === 'content' ? (
        <>
          <Path d="M16 9H40L50 19V53H16C12.686 53 10 50.314 10 47V15C10 11.686 12.686 9 16 9Z" {...common} />
          <Path d="M40 9V19H50M20 31H39M20 39H34M20 47H30" {...common} />
          <Path d="M47 26L49 30L53 32L49 34L47 38L45 34L41 32L45 30L47 26Z" fill={honey} stroke={accent} strokeWidth="1.5" strokeLinejoin="round" />
        </>
      ) : null}
      {name === 'chats' ? (
        <>
          <Path d="M13 15H43C47.418 15 51 18.582 51 23V35C51 39.418 47.418 43 43 43H29L19 51V43H13C8.582 43 5 39.418 5 35V23C5 18.582 8.582 15 13 15Z" fill={colors.cream} {...common} />
          <Path d="M22 23H48C52.418 23 56 26.582 56 31V39C56 43.418 52.418 47 48 47H45V54L36 47H27" {...common} />
          <Circle cx="18" cy="29" r="3" fill={accent} /><Circle cx="28" cy="29" r="3" fill={honey} /><Circle cx="38" cy="29" r="3" fill={accent} />
        </>
      ) : null}
      {name === 'profile' ? (
        <>
          <Path d="M12 32C12 19.85 20.954 10 32 10C43.046 10 52 19.85 52 32V53H12V32Z" {...common} />
          <Circle cx="32" cy="27" r="8" fill={colors.creamStrong} {...common} />
          <Path d="M20 48C21.8 39.8 25.8 36 32 36C38.2 36 42.2 39.8 44 48" {...common} />
          <Circle cx="49" cy="15" r="7" fill={honey} stroke={accent} strokeWidth="2" />
          <Path d="M49 11.5V18.5M45.5 15H52.5" stroke={ink} strokeWidth="2" strokeLinecap="round" />
        </>
      ) : null}
    </Svg>
  );
}
