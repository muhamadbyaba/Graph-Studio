import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { answerQuestion } from '../src/ai/assistant.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

function villa(): PlumbingLayout {
  return new PlumbingLayout(GULF_V1)
    .addNode('t', 'source', 0, 0)
    .addNode('wc', 'fixture', 3, 0, 'WaterCloset')
    .addNode('sh', 'fixture', 3, 3, 'Shower')
    .addPipe('p1', 't', 'wc', 'cold')
    .addPipe('p2', 't', 'sh', 'cold');
}

test('answers a validation question from real model state', () => {
  const a = answerQuestion(villa(), 'what fails?');
  assert.match(a, /pass validation|issue/i);
});

test('answers cost with a real total and discipline breakdown', () => {
  const a = answerQuestion(villa(), 'what is the total cost?');
  assert.match(a, /\$/);
  assert.match(a, /Plumbing/);
});

test('answers quantities from real counts', () => {
  const a = answerQuestion(villa(), 'how many fixtures?');
  assert.match(a, /WaterCloset/);
  assert.match(a, /Shower/);
});

test('“why this size” uses the selected item and returns its trace', () => {
  const a = answerQuestion(villa(), 'why this size?', { selectedPipeId: 'p1' });
  assert.match(a, /p1/);
  assert.match(a, /cold/);
  assert.match(a, /Rule:/);
});

test('“why” without a selection asks the user to pick one', () => {
  assert.match(answerQuestion(villa(), 'why?'), /select/i);
});

test('an unknown question returns a grounded, honest help message', () => {
  assert.match(answerQuestion(villa(), 'write me a poem'), /validation|cost|no guessing|every number/i);
});
