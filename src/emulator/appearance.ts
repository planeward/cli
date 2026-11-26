/**
 * Host appearances the emulator can send apps (`AppContext.appearance` and
 * `planeward:app:theme`): Planeward's own look, and a sample brand so an app
 * can check it follows a community's colours, radius and font.
 */
import {
  parseAppAppearance,
  type AppAppearance,
  type AppAppearanceColor,
  type AppTheme,
} from "@planeward/sdk";

export const EMULATOR_APPEARANCE_PRESETS = ["planeward", "brand"] as const;

export type EmulatorAppearancePreset =
  (typeof EMULATOR_APPEARANCE_PRESETS)[number];

export const DEFAULT_EMULATOR_APPEARANCE_PRESET: EmulatorAppearancePreset =
  "planeward";

type Colors = Partial<Record<AppAppearanceColor, string>>;

type Preset = {
  label: string;
  radius: string;
  font: { family: string; stylesheets: string[] };
  colors: Record<AppTheme, Colors>;
};

/** shadcn's neutral palette. */
const NEUTRAL: Record<AppTheme, Colors> = {
  light: {
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.145 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    secondary: "oklch(0.97 0 0)",
    "secondary-foreground": "oklch(0.205 0 0)",
    muted: "oklch(0.97 0 0)",
    "muted-foreground": "oklch(0.556 0 0)",
    accent: "oklch(0.97 0 0)",
    "accent-foreground": "oklch(0.205 0 0)",
    destructive: "oklch(0.577 0.245 27.325)",
    border: "oklch(0.922 0 0)",
    input: "oklch(0.922 0 0)",
    ring: "oklch(0.708 0 0)",
    "chart-1": "oklch(0.646 0.222 41.116)",
    "chart-2": "oklch(0.6 0.118 184.704)",
    "chart-3": "oklch(0.398 0.07 227.392)",
    "chart-4": "oklch(0.828 0.189 84.429)",
    "chart-5": "oklch(0.769 0.188 70.08)",
    sidebar: "oklch(0.985 0 0)",
    "sidebar-foreground": "oklch(0.145 0 0)",
    "sidebar-primary": "oklch(0.205 0 0)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.97 0 0)",
    "sidebar-accent-foreground": "oklch(0.205 0 0)",
    "sidebar-border": "oklch(0.922 0 0)",
    "sidebar-ring": "oklch(0.708 0 0)",
  },
  dark: {
    background: "oklch(0.145 0 0)",
    foreground: "oklch(0.985 0 0)",
    card: "oklch(0.205 0 0)",
    "card-foreground": "oklch(0.985 0 0)",
    popover: "oklch(0.205 0 0)",
    "popover-foreground": "oklch(0.985 0 0)",
    primary: "oklch(0.922 0 0)",
    "primary-foreground": "oklch(0.205 0 0)",
    secondary: "oklch(0.269 0 0)",
    "secondary-foreground": "oklch(0.985 0 0)",
    muted: "oklch(0.269 0 0)",
    "muted-foreground": "oklch(0.708 0 0)",
    accent: "oklch(0.269 0 0)",
    "accent-foreground": "oklch(0.985 0 0)",
    destructive: "oklch(0.704 0.191 22.216)",
    border: "oklch(1 0 0 / 10%)",
    input: "oklch(1 0 0 / 15%)",
    ring: "oklch(0.556 0 0)",
    "chart-1": "oklch(0.488 0.243 264.376)",
    "chart-2": "oklch(0.696 0.17 162.48)",
    "chart-3": "oklch(0.769 0.188 70.08)",
    "chart-4": "oklch(0.627 0.265 303.9)",
    "chart-5": "oklch(0.645 0.246 16.439)",
    sidebar: "oklch(0.205 0 0)",
    "sidebar-foreground": "oklch(0.985 0 0)",
    "sidebar-primary": "oklch(0.488 0.243 264.376)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.269 0 0)",
    "sidebar-accent-foreground": "oklch(0.985 0 0)",
    "sidebar-border": "oklch(1 0 0 / 10%)",
    "sidebar-ring": "oklch(0.556 0 0)",
  },
};

/** shadcn's violet theme over a lightly tinted base. */
const VIOLET: Record<AppTheme, Colors> = {
  light: {
    ...NEUTRAL.light,
    background: "oklch(0.995 0.003 293)",
    muted: "oklch(0.967 0.012 293)",
    "muted-foreground": "oklch(0.541 0.03 293)",
    secondary: "oklch(0.967 0.012 293)",
    "secondary-foreground": "oklch(0.283 0.141 291.089)",
    accent: "oklch(0.943 0.029 294.588)",
    "accent-foreground": "oklch(0.283 0.141 291.089)",
    primary: "oklch(0.541 0.281 293.009)",
    "primary-foreground": "oklch(0.969 0.016 293.756)",
    border: "oklch(0.92 0.014 293)",
    input: "oklch(0.92 0.014 293)",
    ring: "oklch(0.702 0.183 293.541)",
    sidebar: "oklch(0.985 0.006 293)",
    "sidebar-primary": "oklch(0.541 0.281 293.009)",
    "sidebar-primary-foreground": "oklch(0.969 0.016 293.756)",
    "sidebar-accent": "oklch(0.943 0.029 294.588)",
    "sidebar-accent-foreground": "oklch(0.283 0.141 291.089)",
    "sidebar-border": "oklch(0.92 0.014 293)",
    "sidebar-ring": "oklch(0.702 0.183 293.541)",
  },
  dark: {
    ...NEUTRAL.dark,
    background: "oklch(0.16 0.02 293)",
    card: "oklch(0.21 0.03 293)",
    popover: "oklch(0.21 0.03 293)",
    muted: "oklch(0.27 0.035 293)",
    "muted-foreground": "oklch(0.72 0.04 293)",
    secondary: "oklch(0.27 0.035 293)",
    accent: "oklch(0.3 0.06 293)",
    primary: "oklch(0.606 0.25 292.717)",
    "primary-foreground": "oklch(0.969 0.016 293.756)",
    ring: "oklch(0.541 0.281 293.009)",
    sidebar: "oklch(0.21 0.03 293)",
    "sidebar-primary": "oklch(0.606 0.25 292.717)",
    "sidebar-primary-foreground": "oklch(0.969 0.016 293.756)",
    "sidebar-accent": "oklch(0.3 0.06 293)",
    "sidebar-ring": "oklch(0.541 0.281 293.009)",
  },
};

const PRESETS: Record<EmulatorAppearancePreset, Preset> = {
  planeward: {
    label: "Planeward default",
    radius: "0.625rem",
    font: {
      family: "Geist",
      stylesheets: [
        "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap",
      ],
    },
    colors: NEUTRAL,
  },
  brand: {
    label: "Sample brand",
    radius: "1rem",
    font: {
      family: "Nunito",
      stylesheets: [
        "https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700&display=swap",
      ],
    },
    colors: VIOLET,
  },
};

export function isEmulatorAppearancePreset(
  value: unknown
): value is EmulatorAppearancePreset {
  return (EMULATOR_APPEARANCE_PRESETS as readonly unknown[]).includes(value);
}

export function emulatorAppearanceLabel(
  preset: EmulatorAppearancePreset
): string {
  return PRESETS[preset].label;
}

/**
 * The appearance a preset sends in `theme` mode, through the SDK's
 * `parseAppAppearance` so it is exactly what an app receives.
 */
export function emulatorAppearance(
  preset: EmulatorAppearancePreset,
  theme: AppTheme
): AppAppearance | undefined {
  const { colors, radius, font } = PRESETS[preset];
  return parseAppAppearance({ colors: colors[theme], radius, font });
}
