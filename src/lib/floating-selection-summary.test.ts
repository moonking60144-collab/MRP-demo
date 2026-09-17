import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampFloatingPanelPosition,
  resolveFloatingPanelInitialPosition,
} from '../components/ui/floating-selection-summary';

test('浮動框選視窗的位置會限制在目前 viewport 內', () => {
  const panel = { width: 480, height: 160 };
  const viewport = { width: 1_440, height: 900 };

  assert.deepEqual(
    clampFloatingPanelPosition({ x: -200, y: -50 }, panel, viewport),
    { x: 8, y: 8 },
  );
  assert.deepEqual(
    clampFloatingPanelPosition({ x: 2_000, y: 1_500 }, panel, viewport),
    { x: 952, y: 732 },
  );
});

test('浮動框選視窗初始位置在右上方並保留安全間距', () => {
  assert.deepEqual(
    resolveFloatingPanelInitialPosition(
      { width: 480, height: 160 },
      { width: 1_440, height: 900 },
    ),
    { x: 936, y: 112 },
  );
});

test('viewport 小於浮窗時仍保留左上安全邊界', () => {
  assert.deepEqual(
    clampFloatingPanelPosition(
      { x: 500, y: 500 },
      { width: 480, height: 240 },
      { width: 375, height: 220 },
    ),
    { x: 8, y: 8 },
  );
});
