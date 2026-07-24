import test from 'node:test';
import assert from 'node:assert/strict';

await import('../chrome-extension/campaign-context.js');
const {extractCampaignIdsFromText,normalizeCampaignIds,chooseEntityMatch}=globalThis.WBAContext;

test('extracts and de-duplicates campaign IDs visible on a WB page',()=>{
  assert.deepEqual(extractCampaignIdsFromText('Кампания ID 12345; ID: 678901; снова ID 12345'),['12345','678901']);
});

test('normalizes only valid campaign IDs',()=>{
  assert.deepEqual(normalizeCampaignIds(['12345',12345,' 678901 ','12','bad']),['12345','678901']);
});

test('chooses a unique entity with the most matching campaigns',()=>{
  assert.equal(chooseEntityMatch([{entity_id:2,match_count:3},{entity_id:1,match_count:1}]).entity_id,2);
  assert.equal(chooseEntityMatch([{entity_id:2,match_count:1},{entity_id:1,match_count:1}]),null);
});
