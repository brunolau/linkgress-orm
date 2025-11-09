import { ICollectionStrategy, CollectionStrategyType } from './collection-strategy.interface';
import { JsonbCollectionStrategy } from './strategies/jsonb-collection-strategy';
import { TempTableCollectionStrategy } from './strategies/temptable-collection-strategy';

/**
 * Factory for creating collection aggregation strategies
 */
export class CollectionStrategyFactory {
  private static strategies = new Map<CollectionStrategyType, ICollectionStrategy>();

  /**
   * Get a strategy instance (singleton per type)
   */
  static getStrategy(type: CollectionStrategyType): ICollectionStrategy {
    if (!this.strategies.has(type)) {
      switch (type) {
        case 'jsonb':
          this.strategies.set(type, new JsonbCollectionStrategy());
          break;
        case 'temptable':
          this.strategies.set(type, new TempTableCollectionStrategy());
          break;
        default:
          throw new Error(`Unknown collection strategy type: ${type}`);
      }
    }
    return this.strategies.get(type)!;
  }

  /**
   * Clear cached strategies (mainly for testing)
   */
  static clearCache(): void {
    this.strategies.clear();
  }
}
