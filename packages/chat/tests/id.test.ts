import { describe, expect, it } from 'vitest';
import { now, Time } from '@/id';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function wallClock(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

describe('Time', () => {
  it('JSON 里是本机时区的墙上时钟', () => {
    const time = must(Time(1792149912000));
    const text = JSON.parse(JSON.stringify({ time })).time;
    expect(time).toBeInstanceOf(Date);
    expect(text).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('跟本机时区一致，午夜不写成 24 点', () => {
    const midnight = new Date(2026, 9, 16, 0, 0, 0).getTime();
    for (const ms of [1792149912000, midnight, Date.now()]) {
      expect(must(Time(ms)).toJSON()).toBe(wallClock(ms));
    }
  });

  it('now() 是此刻的 Time', () => {
    expect(now().getTime()).toBeGreaterThan(0);
  });
});
