import {
  EventStoreDBClient,
  EventType,
  jsonEvent,
  JSONEventType,
  RecordedEvent,
  ResolvedEvent,
  StreamingRead,
} from "@eventstore/db-client";
import { v4 as uuid } from "uuid";

/***************************************
 **************  EVENTS  ***************
 ***************************************/
// All these types are Readonly because events should be immutable
type ShoppingCartOpened = JSONEventType<
  "shopping-cart-opened",
  Readonly<{
    shoppingCartId: string;
    clientId: string;
    openedAt: Date;
  }>
>;

type ProductItemAddedToShoppingCart = JSONEventType<
  "product-item-added-to-shopping-cart",
  Readonly<{
    shoppingCartId: string;
    productItem: ProductItem;
  }>
>;
type ProductItemRemovedFromShoppingCart = JSONEventType<
  "product-item-removed-from-shopping-cart",
  Readonly<{
    shoppingCartId: string;
    productItem: ProductItem;
  }>
>;

type ShoppingCartConfirmed = JSONEventType<
  "shopping-cart-confirmed",
  Readonly<{
    shoppingCartId: string;
    confirmedAt: Date;
  }>
>;

type ProductItem = {
  productId: string;
  quantity: number;
};

type ShoppingCartEvent =
  | ShoppingCartOpened
  | ProductItemAddedToShoppingCart
  | ProductItemRemovedFromShoppingCart
  | ShoppingCartConfirmed;

/***************************************
 *********  STATES (ENTITIES)  *********
 ***************************************/
type ShoppingCart = Readonly<{
  id: string;
  clientId: string;
  status: ShoppingCartStatus;
  productItems: ProductItem[];
  openedAt: Date;
  confirmedAt?: Date;
}>;

enum ShoppingCartStatus {
  Opened = 1,
  Confirmed = 2,
  Cancelled = 4,
  Closed = Confirmed | Cancelled,
}

const toShoppingCartStreamName = (shoppingCartId: string) =>
  `shopping_cart-${shoppingCartId}`;

// Transformation/application method
// In ES this method is also called 'when'
// This method takes the current state, which could be undefined, and an event,
// and returns the new current state, as a result of applying the event to the current state
type ApplyEvent<Entity, E extends EventType> = (
  currentState: Entity | undefined,
  event: RecordedEvent<E>
) => Entity;

// This method takes a list of events (for example, reading from the event store)
// and for each of them it applies the 'when' argument (defined as the 'ApplyEvent' above)
const StreamAggregator =
  <Entity, E extends EventType>(when: ApplyEvent<Entity, E>) =>
  async (eventStream: StreamingRead<ResolvedEvent<E>>): Promise<Entity> => {
    let currentState: Entity | undefined = undefined;

    for await (const { event } of eventStream) {
      if (!event) continue;
      currentState = when(currentState, event);
    }

    if (currentState == null) throw StreamAggregatorError.STREAM_WAS_NOT_FOUND;

    return currentState;
  };

const enum StreamAggregatorError {
  STREAM_WAS_NOT_FOUND,
}

const enum ShoppingCartError {
  OPENED_EXISTING_CART = "OPENED_EXISTING_CART",
  UNKNOW_EVENT_TYPE = "UNKNOW_EVENT_TYPE",
  CART_NOT_FOUND = "CART_NOT_FOUND",
  PRODUCT_ITEM_NOT_FOUND = "PRODUCT_ITEM_NOT_FOUND",
}

const getShoppingCart = StreamAggregator<ShoppingCart, ShoppingCartEvent>(
  (currentState, event) => {
    // Opening a cart is a special case, we need to assure that no previous state exists and then we return a default entity
    if (event.type === "shopping-cart-opened") {
      if (currentState != null) throw ShoppingCartError.OPENED_EXISTING_CART;
      return {
        id: event.data.shoppingCartId,
        clientId: event.data.clientId,
        openedAt: new Date(event.data.openedAt),
        productItems: [],
        status: ShoppingCartStatus.Opened,
      };
    }

    // If at this point no state exists, we throw an error
    if (currentState == null) throw ShoppingCartError.CART_NOT_FOUND;

    switch (event.type) {
      case "product-item-added-to-shopping-cart":
        return {
          ...currentState,
          productItems: addProductItem(
            currentState.productItems,
            event.data.productItem
          ),
        };
      case "product-item-removed-from-shopping-cart":
        return {
          ...currentState,
          productItems: removeProductItem(
            currentState.productItems,
            event.data.productItem
          ),
        };
      case "shopping-cart-confirmed":
        return {
          ...currentState,
          status: ShoppingCartStatus.Confirmed,
          confirmedAt: new Date(event.data.confirmedAt),
        };
      default: {
        const _: never = event;
        throw ShoppingCartError.UNKNOW_EVENT_TYPE;
      }
    }
  }
);

/*
 * Add a product item to the current list:
 * - if the list doesn't contain the specified item, just add it with the provided quantity;
 * - if the list already contain the specified item, udpate its quantity
 */
const addProductItem = (
  productItems: ProductItem[],
  newProductItem: ProductItem
): ProductItem[] => {
  const { productId, quantity } = newProductItem;

  const currentProductItem = findProductItem(productItems, productId);

  if (!currentProductItem) return [...productItems, newProductItem];

  const newQuantity = currentProductItem.quantity + quantity;
  const mergedProductItem = { productId, quantity: newQuantity };

  return productItems.map((pi) =>
    pi.productId === productId ? mergedProductItem : pi
  );
};

const findProductItem = (
  productItems: ProductItem[],
  productId: string
): ProductItem | undefined => {
  return productItems.find((pi) => pi.productId === productId);
};

/*
 * Remove a product item from the current list:
 * - if the list doesn't contain the specified item, or the quantity of the item to remove is larger than the current quantity, throws an error;
 * - otherwise reduce the current quantity by the specified quantity
 *
 * If the quantity after the removal is equal to zero, remove the item from the list.
 */
const removeProductItem = (
  productItems: ProductItem[],
  productItemToRemove: ProductItem
): ProductItem[] => {
  const { productId, quantity } = productItemToRemove;

  const currentProductItem = assertProductItemExists(
    productItems,
    productItemToRemove
  );

  const newQuantity = currentProductItem.quantity - quantity;

  if (newQuantity === 0) {
    return productItems.filter((pi) => pi.productId !== productId);
  }

  const mergedProductItem = { productId, quantity: newQuantity };
  return productItems.map((pi) =>
    pi.productId === productId ? mergedProductItem : pi
  );
};

const assertProductItemExists = (
  productItems: ProductItem[],
  { productId, quantity }: ProductItem
): ProductItem => {
  const currentProductItem = findProductItem(productItems, productId);

  if (!currentProductItem || currentProductItem.quantity < quantity) {
    throw ShoppingCartError.PRODUCT_ITEM_NOT_FOUND;
  }

  return currentProductItem;
};

/***************************************
 *********         RUN         *********
 ***************************************/
const enum ProductsIds {
  T_SHIRT = "team-building-exercise-2023",
  SHOES = "air-jordan",
}

(async () => {
  const clientId = "client-123";
  const shoppingCartId = `cart-${uuid()}`;

  // Already existing stream of events
  const events: ShoppingCartEvent[] = [
    {
      type: "shopping-cart-opened",
      data: {
        shoppingCartId,
        clientId,
        openedAt: new Date(),
      },
    },
    {
      type: "product-item-added-to-shopping-cart",
      data: {
        shoppingCartId,
        productItem: {
          productId: ProductsIds.SHOES,
          quantity: 1,
        },
      },
    },
    {
      type: "product-item-added-to-shopping-cart",
      data: {
        shoppingCartId,
        productItem: {
          productId: ProductsIds.T_SHIRT,
          quantity: 3,
        },
      },
    },
    {
      type: "product-item-removed-from-shopping-cart",
      data: {
        shoppingCartId,
        productItem: {
          productId: ProductsIds.SHOES,
          quantity: 1,
        },
      },
    },
    {
      type: "shopping-cart-confirmed",
      data: {
        shoppingCartId,
        confirmedAt: new Date(),
      },
    },
  ];

  const streamName = toShoppingCartStreamName(shoppingCartId);

  // Event store connection
  const eventStore = EventStoreDBClient.connectionString(
    "esdb://localhost:2113?tls=false"
  );

  await eventStore.appendToStream<ShoppingCartEvent>(
    streamName,
    events.map((e) => jsonEvent<ShoppingCartEvent>(e))
  );

  const shoppingCartStream =
    eventStore.readStream<ShoppingCartEvent>(streamName);

  const cart = await getShoppingCart(shoppingCartStream);

  console.log(cart);
})();
