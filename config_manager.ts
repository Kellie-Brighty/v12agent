import fs from 'fs';
import path from 'path';

export interface BotConfig {
  DRY_RUN: boolean;
  RISK_PERCENT: number;
  SWING_LOOKBACK: number;
  HTF_SWING_LOOKBACK: number;
  MIN_FVG_PIPS: number;
  MIN_RR: number;
  FVG_PROXIMITY: number;
  MIN_SWEEP_DISTANCE: number;
  [key: string]: string | number | boolean;
}

const DEFAULT_CONFIG: BotConfig = {
  DRY_RUN: true,
  RISK_PERCENT: 0.01,
  SWING_LOOKBACK: 5,
  HTF_SWING_LOOKBACK: 3,
  MIN_FVG_PIPS: 0.0008,
  MIN_RR: 1.5,
  FVG_PROXIMITY: 3.0,
  MIN_SWEEP_DISTANCE: 0.0005,
};

const CONFIG_PATH = path.join(process.cwd(), 'learned_config.json');

/**
 * Reads the latest configuration, merging dynamic learned parameters with defaults.
 */
export function getConfig(): BotConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const fileData = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const learnedConfig = JSON.parse(fileData);
    return { ...DEFAULT_CONFIG, ...learnedConfig };
  } catch (error) {
    console.error('Failed to parse learned_config.json. Falling back to defaults.', error);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Safely updates the learned configuration file with new AI-generated parameters.
 */
export function updateConfig(newParams: Partial<BotConfig>): void {
  const currentConfig = getConfig();
  
  // Merge the new overrides into existing overrides, not into defaults directly
  // This allows us to keep the file clean containing ONLY the overridden values
  let existingOverrides = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existingOverrides = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }

  const updatedOverrides = { ...existingOverrides, ...newParams };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedOverrides, null, 2), 'utf-8');
  console.log('✅ Configuration successfully updated dynamically:', newParams);
}
