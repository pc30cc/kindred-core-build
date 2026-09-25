package com.webyar.operator.core.cache

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.webyar.operator.WebyarApp
import java.util.concurrent.TimeUnit

/**
 * The cache's housekeeping, once a day, when it costs nobody anything.
 *
 * Retention for the database, the budget for the attachment files. No
 * network at all — this is the one job that never makes a request — and
 * only with a battery that is not low: a trim can wait a day, a phone at 5%
 * cannot.
 */
class CacheMaintenanceWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val graph = (applicationContext as? WebyarApp)?.graph ?: return Result.success()
        runCatching { graph.maintenance() }
        return Result.success()
    }

    companion object {
        private const val NAME = "cache-maintenance"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<CacheMaintenanceWorker>(1, TimeUnit.DAYS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiresBatteryNotLow(true)
                        .build(),
                )
                .setInitialDelay(6, TimeUnit.HOURS)
                .build()
            runCatching {
                WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
            }
        }
    }
}
