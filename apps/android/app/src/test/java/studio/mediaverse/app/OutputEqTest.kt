package studio.mediaverse.app

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OutputEqTest {
    @Test
    fun bluetoothBeatsUsbBeatsWiredBeatsTheSpeaker() {
        val speaker = OutputEq.Output(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "")
        val wired = OutputEq.Output(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, "")
        val usb = OutputEq.Output(AudioDeviceInfo.TYPE_USB_HEADSET, "DAC")
        val car = OutputEq.Output(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "My Car")
        assertEquals(speaker, OutputEq.pick(listOf(speaker)))
        assertEquals(wired, OutputEq.pick(listOf(speaker, wired)))
        assertEquals(usb, OutputEq.pick(listOf(speaker, wired, usb)))
        assertEquals(car, OutputEq.pick(listOf(speaker, wired, usb, car)))
        assertNull(OutputEq.pick(listOf(OutputEq.Output(AudioDeviceInfo.TYPE_TELEPHONY, ""))))
    }

    @Test
    fun bluetoothDevicesAreToldApartByName() {
        assertEquals("bt:my car" to "Bluetooth: My Car", OutputEq.keyOf(OutputEq.Output(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "My Car")))
        assertEquals("wired", OutputEq.keyOf(OutputEq.Output(AudioDeviceInfo.TYPE_WIRED_HEADSET, "")).first)
        assertEquals("speaker", OutputEq.keyOf(OutputEq.Output(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "")).first)
    }

    @Test
    fun levelsAreFilledAndKeptInsideTheRange() {
        assertEquals(listOf(-1500, 0, 1500, 0), OutputEq.clampLevels(listOf(-9000, 0, 9000), 4, -1500, 1500))
    }
}
