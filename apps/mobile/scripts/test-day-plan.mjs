import assert from 'node:assert/strict';
import { fitDailySlot } from '../src/content/dayPlan.ts';

const day = '2030-06-10';
assert.equal(fitDailySlot(new Date(2030, 5, 10, 10), new Date(2030, 5, 10, 9), day).getHours(), 10);
assert.equal(fitDailySlot(new Date(2030, 5, 10, 10), new Date(2030, 5, 10, 16, 30), day).getHours(), 16);
assert.throws(() => fitDailySlot(new Date(2030, 5, 10, 10), new Date(2030, 5, 11), day));
assert.throws(() => fitDailySlot(new Date('invalid'), new Date(2030, 5, 10), day));
console.log('Daily plan stays within the selected day');
