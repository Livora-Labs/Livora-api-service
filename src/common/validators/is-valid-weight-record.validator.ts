import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export interface IsValidWeightRecordOptions {
  min?: number;
  maxDecimalPlaces?: number;
  allowEmpty?: boolean;
}

export function IsValidWeightRecord(
  options?: IsValidWeightRecordOptions,
  validationOptions?: ValidationOptions,
) {
  const min = options?.min ?? 0.5;
  const maxDecimalPlaces = options?.maxDecimalPlaces ?? 2;
  const allowEmpty = options?.allowEmpty ?? false;

  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidWeightRecord',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, _args: ValidationArguments) {
          if (value === null || value === undefined) {
            return allowEmpty;
          }

          if (typeof value !== 'object' || Array.isArray(value)) {
            return false;
          }

          const entries = Object.entries(value);
          if (entries.length === 0) {
            return allowEmpty;
          }

          for (const [key, val] of entries) {
            if (typeof key !== 'string' || key.trim().length === 0) {
              return false;
            }

            const num = typeof val === 'number' ? val : Number(val);
            if (
              typeof val !== 'number' &&
              (typeof val !== 'string' || isNaN(num))
            ) {
              return false;
            }

            if (!Number.isFinite(num) || isNaN(num)) {
              return false;
            }

            if (num < min) {
              return false;
            }

            // Validar máximo número de decimales
            const parts = num.toString().split('.');
            if (parts.length > 1 && parts[1].length > maxDecimalPlaces) {
              return false;
            }
          }

          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} debe ser un objeto con valores numéricos mayores o iguales a ${min} y un máximo de ${maxDecimalPlaces} decimales`;
        },
      },
    });
  };
}
