import { growthFollowups, growthPlans } from '../db.js';
import { generateGrowthPlanForLead, readGrowthPlanRow, readGrowthState } from './planner.js';
import { recordGrowthCustomerResponse, sendGrowthRecap } from './followup.js';
import { classifyGrowthReply } from './replyPolicy.js';

export {
  classifyGrowthReply,
  generateGrowthPlanForLead,
  readGrowthPlanRow,
  readGrowthState,
  recordGrowthCustomerResponse,
  sendGrowthRecap
};

export function growthStatus() {
  const planSummary = growthPlans.summary();
  const followupSummary = growthFollowups.summary();
  return {
    plans: planSummary,
    followups: followupSummary,
    capabilities: {
      growthPlan: 'synthetic_or_gemini_provider',
      offers: ['starter_website', 'website_local_seo', 'review_system', 'booking_contact_automation', 'monthly_maintenance'],
      agentmailGrowthRecap: 'gated_by_opt_out_and_LIVE_EMAILS',
      replyClassification: ['interested', 'not_now', 'unsubscribe', 'handoff'],
      memoryKind: 'growth_plan'
    }
  };
}
