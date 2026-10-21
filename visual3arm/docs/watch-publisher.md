# Публикация rotation vector с Galaxy Watch 6

Galaxy Watch 6 — это Wear OS 4, то есть обычное Android-приложение с `SensorManager`.
Ниже минимальный издатель: датчик → MQTT-топик, который ждёт визуализатор.

## Зависимости и манифест

```kotlin
// build.gradle.kts (модуль часов)
dependencies {
    implementation("org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5")
}
```

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-feature android:name="android.hardware.sensor.gyroscope" />
```

Часы должны быть в той же сети, что и брокер: на Galaxy Watch включите Wi-Fi
(Настройки → Подключения → Wi-Fi). Через Bluetooth-мост к телефону трафик не пойдёт.

## Издатель

```kotlin
class RotationPublisher(
    context: Context,
    private val brokerUrl: String = "tcp://192.168.1.10:1883",
    private val topic: String = "robot/watch/rotation",
    private val targetHz: Int = 50,
) : SensorEventListener {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val client = MqttClient(brokerUrl, "galaxy-watch-6", MemoryPersistence())
    private val minIntervalNs = 1_000_000_000L / targetHz
    private var lastSentNs = 0L

    fun start() {
        client.connect(MqttConnectOptions().apply {
            isCleanSession = true
            isAutomaticReconnect = true
            connectionTimeout = 5
            keepAliveInterval = 15
        })
        // SENSOR_DELAY_GAME ≈ 50 Гц. Для ~100 Гц: SensorManager.SENSOR_DELAY_FASTEST.
        sensorManager.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_GAME)
    }

    fun stop() {
        sensorManager.unregisterListener(this)
        if (client.isConnected) client.disconnect()
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.timestamp - lastSentNs < minIntervalNs) return
        lastSentNs = event.timestamp

        val v = event.values
        // values[3] (w) есть с API 18, values[4] — точность курса, может отсутствовать.
        val w = if (v.size > 3) v[3] else sqrt(max(0f, 1f - v[0] * v[0] - v[1] * v[1] - v[2] * v[2]))
        val acc = if (v.size > 4) v[4] else 0f

        val payload = "[${event.timestamp},${v[0]},${v[1]},${v[2]},$w,$acc]"
        // QoS 0 без retain: для потока телеметрии переотправка вреднее потери пакета.
        runCatching { client.publish(topic, MqttMessage(payload.toByteArray()).apply { qos = 0 }) }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
```

Формат `[t, x, y, z, w, acc]` визуализатор разбирает без настроек: 6 чисел — первое
считается меткой времени (наносекунды от загрузки переводятся в секунды).

Если удобнее JSON — подойдёт и такой вид, парсер его тоже понимает:

```kotlin
val payload = """{"t":${event.timestamp},"values":[${v[0]},${v[1]},${v[2]},$w],"accuracy":$acc}"""
```

## Про частоту и батарею

- `SENSOR_DELAY_GAME` (~50 Гц) хватает для плавной картинки; `SENSOR_DELAY_FASTEST`
  (~100 Гц) заметно греет часы и почти ничего не добавляет визуально —
  сглаживание в визуализаторе всё равно стоит на ~50 мс.
- Публиковать нужно из foreground service, иначе Wear OS усыпит процесс через
  несколько минут с погашенным экраном.

## Задел: добавить линейное ускорение

Когда дойдёт до координат, а не только углов, к тому же слушателю добавляется
`TYPE_LINEAR_ACCELERATION` (гравитация уже вычтена) и кладётся в тот же пакет:

```kotlin
val payload = """{"t":$ts,"values":[$x,$y,$z,$w],"accuracy":$acc,"linearAccel":[$ax,$ay,$az]}"""
```

Визуализатору больше ничего дописывать не нужно: поле `linearAccel` парсер уже
разбирает, останется только переключить «Координаты» в панели «Рука» на
«интегрировать ускорение».

## Проверка без часов

```bash
mosquitto_pub -h localhost -t 'robot/watch/rotation' -m '[0,0,0,1]'
mosquitto_sub -h localhost -t 'robot/watch/rotation' -v
```

Либо просто оставить в приложении источник «Симулятор».
