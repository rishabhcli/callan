import { accountManagerPlans, accountTasks } from '../db.js';
import { generateAccountManagerPlanForLead, readAccountManagerState } from './planner.js';
import {
  approveAccountTask,
  buildAftercarePreview,
  completeAccountTask,
  ACCOUNT_MANAGER_RUN_JOB_TYPE,
  ACCOUNT_MANAGER_TASK_JOB_TYPE,
  enqueueAccountManagerRun,
  enqueueAccountManagerTask,
  evaluateSendPolicy,
  handleAccountManagerRunJob,
  handleAccountManagerTaskJob,
  pauseAccountTask,
  processAccountTask,
  reassignAccountTask,
  runAccountManagerScheduler,
  startAccountManagerLoop,
  stopAccountManagerLoop
} from './scheduler.js';

export {
  approveAccountTask,
  buildAftercarePreview,
  completeAccountTask,
  ACCOUNT_MANAGER_RUN_JOB_TYPE,
  ACCOUNT_MANAGER_TASK_JOB_TYPE,
  enqueueAccountManagerRun,
  enqueueAccountManagerTask,
  evaluateSendPolicy,
  generateAccountManagerPlanForLead,
  handleAccountManagerRunJob,
  handleAccountManagerTaskJob,
  pauseAccountTask,
  processAccountTask,
  readAccountManagerState,
  reassignAccountTask,
  runAccountManagerScheduler,
  startAccountManagerLoop,
  stopAccountManagerLoop
};

export function accountManagerStatus() {
  return {
    plans: accountManagerPlans.summary(),
    tasks: accountTasks.summary(),
    operatorBoard: accountTasks.operatorBoardSummary(),
    capabilities: {
      planModel: 'account_manager_plan.v1',
      persistence: ['account_manager_plans', 'account_tasks', 'account_task_history', 'account_task_operator_board_escalations', 'account_operator_board_work_items', 'account_operator_board_work_item_receipts', 'account_operator_board_retention_feedback_receipts'],
      scheduler: 'durable_jobs_dry_run_by_default',
      durableJobTypes: [ACCOUNT_MANAGER_RUN_JOB_TYPE, ACCOUNT_MANAGER_TASK_JOB_TYPE],
      liveEmailGate: 'LIVE_EMAILS plus AgentMail config plus run-mode allow-list plus operator approval',
      escalationGate: 'operator-board escalation, lifecycle, and retention-feedback receipts are local only; no customer message, provider call, billing change, booking, payment link, playbook mutation, or account-task completion',
      memoryKind: 'account_manager_plan',
      taskKinds: [
        'promised_edit',
        'stale_business_fact',
        'launch_followup',
        'review_capture',
        'google_business_profile_hygiene',
        'seasonal_hours',
        'service_menu_changes',
        'analytics_contact_flow_check',
        'hosting_subscription_status',
        'renewal_closeout_health_check'
      ]
    }
  };
}
