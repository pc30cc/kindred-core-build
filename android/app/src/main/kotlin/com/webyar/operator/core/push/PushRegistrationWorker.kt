package com.webyar.operator.core.push

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.webyar.operator.WebyarApp
import java.util.concurrent.TimeUnit

/**
 * Registers this device again, when there is a network to do it on.
 *
 * What WorkManager is used for here — a one-off job with a network
 * constraint and exponential backoff — and nothing like polling. A token
 * rotation can arrive with the app closed and the phone offline; this is
 * what makes it land eventually, and in the meantime the phone is asleep.
 */
class PushRegistrationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val graph = (applicationContext as? WebyarApp)?.graph ?: return Result.failure()
        val reason = inputData.getString(KEY_REASON) ?: "retry"
        return when (graph.push.sync(reason)) {
            PushResult.RETRY_LATER -> if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.failure()
            else -> Result.success()
        }
    }

    companion object {
        private const val NAME = "push-registration"
        private const val KEY_REASON = "reason"
        private const val MAX_ATTEMPTS = 6

        /**
         * [replace] is for news — a new token — which should start a fresh
         * attempt now. A failure inside an attempt keeps the one already
         * queued, rather than cancelling the worker that is reporting it.
         */
        fun enqueue(context: Context, reason: String, replace: Boolean = true) {
            val request = OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(KEY_REASON to reason))
                .build()
            runCatching {
                WorkManager.getInstance(context).enqueueUniqueWork(
                    NAME,
                    if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                    request,
                )
            }
        }

        fun cancel(context: Context) {
            runCatching { WorkManager.getInstance(context).cancelUniqueWork(NAME) }
        }
    }
}
