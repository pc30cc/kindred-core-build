package com.webyar.operator.core

import kotlin.coroutines.cancellation.CancellationException

/**
 * [runCatching], without the part that catches cancellation.
 *
 * `kotlin.runCatching` catches `Throwable`, and inside a coroutine that
 * includes the `CancellationException` the machinery throws to unwind a
 * cancelled job. So `runCatching` around a suspending call does not mean "if
 * this fails". It means "if this fails, **or if it was cancelled**" — and the
 * two want opposite handling. A failure is an outcome to show somebody; a
 * cancellation is this work going away, and there is nobody left to show
 * anything to.
 *
 * Conflating them is not theoretical. A `LaunchedEffect` whose key changed
 * while the invitation POST was in flight had that request cancelled, the
 * `runCatching` around it reported the cancellation as a failed call, and the
 * call screen latched on "the call could not connect" — while the invitation
 * the relaunched effect created went on to ring, be answered, and connect.
 * The operator sat watching a live call from behind an error message.
 *
 * Rethrowing lets cancellation do its job: the coroutine unwinds, and
 * whoever cancelled it gets the silence they asked for.
 */
inline fun <T> runCatchingUnlessCancelled(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        Result.failure(error)
    }
