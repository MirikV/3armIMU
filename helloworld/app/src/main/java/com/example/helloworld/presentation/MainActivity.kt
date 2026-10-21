package com.example.helloworld.presentation

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalView
import androidx.wear.compose.material3.*
import androidx.wear.compose.ui.tooling.preview.WearPreviewDevices
import androidx.wear.compose.ui.tooling.preview.WearPreviewFontScales
import com.example.helloworld.presentation.theme.HelloworldTheme
import android.app.Activity
import android.view.WindowManager
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.util.Log
import org.eclipse.paho.client.mqttv3.*
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.sqrt

// ==== Настройки MQTT — поменяй под свой брокер ====
private const val BROKER_URI = "tcp://10.228.183.110:1883" // IP компьютера/Pi с Mosquitto
private const val CLIENT_ID = "galaxy-watch-1"
private const val TOPIC = "robot/watch/rotation"

// ==== Частота отправки ====
// Датчик на SENSOR_DELAY_GAME даёт 50–100 Гц, в топик отдаём ~50 Гц:
// визуализатор всё равно сглаживает на ~50 мс, лишние пакеты только греют часы.
private const val TARGET_HZ = 50
private const val MIN_INTERVAL_NS = 1_000_000_000L / TARGET_HZ
// Логируем не каждый пакет, а каждый LOG_EVERY-й (~2 строки в секунду):
// onSensorChanged крутится на главном потоке, форматирование строк там лишнее.
private const val LOG_EVERY = 25

fun logAllSensors(context: Context) {
    val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    for (sensor in sensorManager.getSensorList(Sensor.TYPE_ALL)) {
        Log.d("SENSOR_LIST", "Name: ${sensor.name}, Type: ${sensor.type}, Vendor: ${sensor.vendor}")
    }
}

class MainActivity : ComponentActivity() {

    private var mqttClient: MqttAsyncClient? = null
    var isMqttConnected by mutableStateOf(false)
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        connectMqtt()

        setContent {
            GyroScreen(
                mqttClient = mqttClient,
                isMqttConnected = isMqttConnected
            )
        }
    }

    private fun connectMqtt() {
        try {
            mqttClient = MqttAsyncClient(BROKER_URI, CLIENT_ID, MemoryPersistence())
            val options = MqttConnectOptions().apply {
                isCleanSession = true
                connectionTimeout = 10
                isAutomaticReconnect = true // сам переподключится при обрыве связи
            }

            mqttClient?.setCallback(object : MqttCallback {
                override fun connectionLost(cause: Throwable?) {
                    Log.d("MQTT", "Соединение потеряно: ${cause?.message}")
                    isMqttConnected = false
                }
                override fun messageArrived(topic: String?, message: MqttMessage?) {}
                override fun deliveryComplete(token: IMqttDeliveryToken?) {}
            })

            mqttClient?.connect(options, null, object : IMqttActionListener {
                override fun onSuccess(asyncActionToken: IMqttToken?) {
                    Log.d("MQTT", "Подключено к брокеру")
                    isMqttConnected = true
                }
                override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                    Log.d("MQTT", "Ошибка подключения: ${exception?.message}")
                    isMqttConnected = false
                }
            })
        } catch (e: MqttException) {
            Log.d("MQTT", "Исключение при инициализации: ${e.message}")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            mqttClient?.disconnect()
            Log.d("MQTT", "Отключено при закрытии приложения")
        } catch (e: MqttException) {
            Log.d("MQTT", "Ошибка при отключении: ${e.message}")
        }
    }
}

@Composable
fun GyroScreen(mqttClient: MqttAsyncClient?, isMqttConnected: Boolean) {
    val context = LocalContext.current
    val isPreview = LocalInspectionMode.current
    val view = LocalView.current

    DisposableEffect(Unit) {
        val window = (view.context as? Activity)?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    val sensorManager = remember {
        if (!isPreview) context.getSystemService(Context.SENSOR_SERVICE) as SensorManager else null
    }

    var isListening by remember { mutableStateOf(false) }

    val rotationListener = remember {
        object : SensorEventListener {
            // Время последнего отправленного пакета, наносекунды SensorEvent.timestamp.
            private var lastSentNs = 0L
            private var packetCount = 0

            override fun onSensorChanged(event: SensorEvent) {
                // Троттлинг до ~TARGET_HZ: сравниваем метки самого датчика, а не часы системы.
                if (event.timestamp - lastSentNs < MIN_INTERVAL_NS) return
                lastSentNs = event.timestamp

                // Сырой кватернион устройство→мир (ENU), порядок x, y, z, w — как кладёт Android.
                val v = event.values
                val x = v[0]
                val y = v[1]
                val z = v[2]
                // values[3] (w) есть не на всех прошивках, а длина массива бывает и 4, и 5.
                // Если w не прислали — достраиваем из единичной нормы, клампим подкоренное:
                // у float оно уходит в небольшой минус около единицы.
                val w = if (v.size > 3) v[3] else sqrt(max(0f, 1f - x * x - y * y - z * z))

                val json = JSONObject().apply {
                    put("ts", System.currentTimeMillis())
                    put("q", JSONArray().apply {
                        put(x.toDouble())
                        put(y.toDouble())
                        put(z.toDouble())
                        put(w.toDouble())
                    })
                }
                val payload = json.toString()

                // Строку всё равно собрали для отправки — в лог кладём её же, но с прореживанием.
                if (packetCount % LOG_EVERY == 0) {
                    Log.d("ROTATION", payload)
                }
                packetCount++

                // Публикуем в MQTT, только если клиент подключён
                if (mqttClient?.isConnected == true) {
                    try {
                        val message = MqttMessage(payload.toByteArray())
                        message.qos = 0
                        mqttClient.publish(TOPIC, message)
                    } catch (e: MqttException) {
                        Log.d("MQTT", "Ошибка публикации: ${e.message}")
                    }
                }
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
    }

    // GAME_ROTATION_VECTOR: без магнитометра, поэтому не дёргается от помех в помещении.
    // Плата — курс относительный; произвольное начало снимается кнопкой обнуления
    // в визуализаторе, см. .claude/contract-mqtt.md.
    val rotationSensor = remember {
        sensorManager?.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR).also {
            if (!isPreview && it == null) {
                Log.d("ROTATION", "TYPE_GAME_ROTATION_VECTOR недоступен на этом устройстве")
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            sensorManager?.unregisterListener(rotationListener)
        }
    }

    HelloworldTheme {
        AppScaffold {
            ScreenScaffold {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Button(
                        // Без датчика включать нечего — кнопка гаснет, а причина видна на экране.
                        enabled = isPreview || rotationSensor != null,
                        onClick = {
                            if (isListening) {
                                sensorManager?.unregisterListener(rotationListener)
                            } else {
                                sensorManager?.registerListener(
                                    rotationListener, rotationSensor, SensorManager.SENSOR_DELAY_GAME
                                )
                            }
                            isListening = !isListening
                        }
                    ) {
                        Text(
                            when {
                                !isPreview && rotationSensor == null -> "Нет датчика поворота"
                                !isMqttConnected -> "MQTT: нет связи"
                                isListening -> "Остановить"
                                else -> "Начать опрос"
                            }
                        )
                    }
                }
            }
        }
    }
}

@WearPreviewDevices
@WearPreviewFontScales
@Composable
fun DefaultPreview() {
    GyroScreen(mqttClient = null, isMqttConnected = false)
}