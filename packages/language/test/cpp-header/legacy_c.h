/* Legacy C header in the style of vendor HAL headers. */
#ifndef LEGACY_C_H
#define LEGACY_C_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define HAL_API
#define HAL_DEPRECATED __attribute__((deprecated))
#define HAL_VERSION_MAJOR 2
#define HAL_VERSION_MINOR 7
#define HAL_VERSION ((HAL_VERSION_MAJOR << 8) | HAL_VERSION_MINOR)
#define HAL_CHANNELS 4

#if HAL_VERSION_MAJOR >= 2
typedef enum {
    HAL_OK = 0x00U,
    HAL_ERROR = 0x01U,
    HAL_BUSY = 0x02U,
    HAL_TIMEOUT = 0x03U
} HAL_StatusTypeDef;
#else
typedef enum { HAL_OLD_STATUS } HAL_StatusTypeDef;
#endif

#if 0
typedef enum { NEVER_SEEN } never_t;
#endif

#if defined(HAL_USE_DMA) && HAL_USE_DMA
typedef struct { int dma_channel; } HAL_DMA_Config;
#elif HAL_CHANNELS > 2
typedef struct {
    uint32_t Channel;          /*!< channel number */
    uint32_t Prescaler;        /*!< prescaler value */
    volatile uint32_t *Reg;    /*!< register (pointers are not supported) */
    uint8_t Data[HAL_CHANNELS];
} HAL_ADC_Config;
#endif

typedef struct __attribute__((packed)) HAL_Frame {
    uint8_t id;
    uint16_t length;
    struct {
        uint8_t major;
        uint8_t minor;
    } version;
    union {
        uint32_t word;
        uint8_t bytes[4];
    } payload;
} HAL_Frame_t;

enum { HAL_MAX_RETRIES = 3, HAL_RETRY_DELAY_MS = HAL_MAX_RETRIES * 10 };

static const int hal_version = HAL_VERSION;
static const unsigned long hal_magic = 0xDEADBEEFUL;
static const char hal_letter = 'x';

typedef void (*HAL_Callback)(HAL_StatusTypeDef status);
typedef uint8_t HAL_Buffer[16];

HAL_API HAL_StatusTypeDef HAL_Init(void);
HAL_API HAL_DEPRECATED void HAL_OldInit(void);
extern volatile uint32_t hal_tick;

#ifdef __cplusplus
}
#endif

#endif /* LEGACY_C_H */
