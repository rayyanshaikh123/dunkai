import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const check = (environment, disabled) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {env} from './src/config/env.js';
    import {reserveCharge,settleCharge} from './src/services/credits.service.js';
    import {publicPlans} from './src/config/plans.js';
    let reservation;
    if(!env.creditMeteringEnabled){
      reservation=await reserveCharge({_id:'test-user'},'local-test',{action:'local_inference'});
      await settleCharge('local-test',{});
    }
    console.log(JSON.stringify({enabled:env.creditMeteringEnabled,bypass:env.disableCreditsForTesting,publicEnabled:publicPlans().meteringEnabled,reservation}));
  `], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_ENV:environment, LOCAL_RUNTIME_ENABLED:'true', BILLING_ENABLED:'false',
      DISABLE_CREDITS_FOR_TESTING:String(disabled), JWT_ACCESS_SECRET:'test-access-secret', JWT_REFRESH_SECRET:'test-refresh-secret', BYOK_ENCRYPTION_KEY:'test-key' },
  });
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
};

test('development testing bypass skips reservations and disables the public quota flag',()=>{
  assert.deepEqual(check('development',true),{enabled:false,bypass:true,publicEnabled:false,reservation:null});
});
test('normal development still enforces credits',()=>{
  assert.deepEqual(check('development',false),{enabled:true,bypass:false,publicEnabled:true});
});
test('production and automated tests ignore the development bypass',()=>{
  for(const environment of ['production','test']) assert.deepEqual(check(environment,true),{enabled:true,bypass:false,publicEnabled:true});
});
