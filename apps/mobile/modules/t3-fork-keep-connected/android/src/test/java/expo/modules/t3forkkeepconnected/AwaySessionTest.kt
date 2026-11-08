package expo.modules.t3forkkeepconnected

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AwaySessionTest {
  @Test
  fun coversTheWholeTimeWhileRunningAndAfterTheReturn() {
    val session = AwaySession(leftAtMs = 1_000, minutes = 5)
    assertFalse(session.coveredWholeTime)
    session.serviceStarted(1_050)
    assertTrue(session.coveredWholeTime)
    assertTrue(session.end(EndReason.RETURNED, 61_000))
    assertTrue(session.coveredWholeTime)
    assertEquals("returned", session.toMap()["endReason"])
  }

  @Test
  fun anEarlierEndMeansTheAppSleptBeforeTheReturn() {
    for (reason in listOf(EndReason.EXPIRED, EndReason.STOPPED, EndReason.SYSTEM)) {
      val session = AwaySession(leftAtMs = 0, minutes = 1)
      session.serviceStarted(10)
      session.end(reason, 60_000)
      // The return that follows does not change how the time away ended.
      assertFalse(session.end(EndReason.RETURNED, 90_000))
      assertFalse(session.coveredWholeTime)
      assertEquals(60_000.0, session.toMap()["endedAtMs"])
    }
  }

  @Test
  fun offAndRefusedStartsNeverCover() {
    val off = AwaySession(leftAtMs = 0, minutes = 0)
    off.end(EndReason.OFF, 0)
    off.serviceStarted(5)
    assertFalse(off.coveredWholeTime)
    assertEquals(false, off.toMap()["started"])

    val refused = AwaySession(leftAtMs = 0, minutes = 5)
    refused.end(EndReason.FAILED, 0)
    assertFalse(refused.coveredWholeTime)
    assertNull(AwaySession(0, 5).toMap()["endReason"])
  }

  @Test
  fun unknownMinutesFallBackToTheDefault() {
    assertEquals(0, sanitizeMinutes(0))
    assertEquals(15, sanitizeMinutes(15))
    assertEquals(DEFAULT_MINUTES, sanitizeMinutes(7))
    assertEquals(DEFAULT_MINUTES, sanitizeMinutes(-1))
  }
}
