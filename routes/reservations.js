var express = require("express");
var router = express.Router();
let mongoose = require("mongoose");

let { checkLogin } = require("../utils/authHandler");
let reservationModel = require("../schemas/reservations");
let cartModel = require("../schemas/carts");
let inventoryModel = require("../schemas/inventories");
let productModel = require("../schemas/products");

const RESERVATION_EXPIRE_MS = 24 * 60 * 60 * 1000;

async function buildReservationItems(items, session) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Danh sach san pham khong hop le");
  }

  let normalizedItems = [];
  let mergedItems = new Map();

  for (const item of items) {
    if (!item || !item.product || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error("Danh sach san pham khong hop le");
    }

    let productId = item.product.toString();
    if (mergedItems.has(productId)) {
      mergedItems.get(productId).quantity += item.quantity;
    } else {
      mergedItems.set(productId, {
        product: productId,
        quantity: item.quantity
      });
    }
  }

  normalizedItems = Array.from(mergedItems.values());

  let productIds = normalizedItems.map(function (item) {
    return item.product;
  });

  let products = await productModel.find({
    _id: { $in: productIds },
    isDeleted: false
  }).session(session);

  let inventories = await inventoryModel.find({
    product: { $in: productIds }
  }).session(session);

  let productMap = new Map();
  for (const product of products) {
    productMap.set(product._id.toString(), product);
  }

  let inventoryMap = new Map();
  for (const inventory of inventories) {
    inventoryMap.set(inventory.product.toString(), inventory);
  }

  if (products.length !== normalizedItems.length || inventories.length !== normalizedItems.length) {
    throw new Error("Co san pham khong ton tai");
  }

  let reservationItems = [];
  let amount = 0;

  for (const item of normalizedItems) {
    let product = productMap.get(item.product);
    let inventory = inventoryMap.get(item.product);
    let availableStock = inventory.stock - inventory.reserved;

    if (availableStock < item.quantity) {
      throw new Error("So luong san pham trong kho khong du");
    }

    inventory.reserved += item.quantity;
    await inventory.save({ session });

    let subtotal = product.price * item.quantity;
    amount += subtotal;

    reservationItems.push({
      product: product._id,
      quantity: item.quantity,
      title: product.title,
      price: product.price,
      subtotal: subtotal
    });
  }

  return {
    reservationItems,
    amount
  };
}

router.get("/", checkLogin, async function (req, res, next) {
  try {
    let reservations = await reservationModel.find({
      user: req.userId
    }).populate("items.product").sort({ createdAt: -1 });

    res.send(reservations);
  } catch (error) {
    res.status(400).send({
      message: error.message
    });
  }
});

router.get("/:id", checkLogin, async function (req, res, next) {
  try {
    let reservation = await reservationModel.findOne({
      _id: req.params.id,
      user: req.userId
    }).populate("items.product");

    if (!reservation) {
      return res.status(404).send({
        message: "reservation khong ton tai"
      });
    }

    res.send(reservation);
  } catch (error) {
    res.status(404).send({
      message: "reservation khong ton tai"
    });
  }
});

router.post("/reserveACart", checkLogin, async function (req, res, next) {
  let session = await mongoose.startSession();
  session.startTransaction();

  try {
    let currentCart = await cartModel.findOne({
      user: req.userId
    }).session(session);

    if (!currentCart || currentCart.cartItems.length === 0) {
      throw new Error("Gio hang trong");
    }

    let builtReservation = await buildReservationItems(currentCart.cartItems, session);

    let newReservation = new reservationModel({
      user: req.userId,
      items: builtReservation.reservationItems,
      amount: builtReservation.amount,
      expiredIn: new Date(Date.now() + RESERVATION_EXPIRE_MS)
    });

    newReservation = await newReservation.save({ session });
    currentCart.cartItems = [];
    await currentCart.save({ session });

    await session.commitTransaction();
    session.endSession();

    let populatedReservation = await reservationModel.findById(newReservation._id)
      .populate("items.product")
      .populate("user");

    res.send(populatedReservation);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).send({
      message: error.message
    });
  }
});

router.post("/reserveItems", checkLogin, async function (req, res, next) {
  let session = await mongoose.startSession();
  session.startTransaction();

  try {
    let items = req.body;
    if (Array.isArray(req.body.products)) {
      items = req.body.products;
    } else if (Array.isArray(req.body.items)) {
      items = req.body.items;
    }

    let builtReservation = await buildReservationItems(items, session);

    let newReservation = new reservationModel({
      user: req.userId,
      items: builtReservation.reservationItems,
      amount: builtReservation.amount,
      expiredIn: new Date(Date.now() + RESERVATION_EXPIRE_MS)
    });

    newReservation = await newReservation.save({ session });

    await session.commitTransaction();
    session.endSession();

    let populatedReservation = await reservationModel.findById(newReservation._id)
      .populate("items.product")
      .populate("user");

    res.send(populatedReservation);
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).send({
      message: error.message
    });
  }
});

router.post("/cancelReserve/:id", checkLogin, async function (req, res, next) {
  try {
    let reservation = await reservationModel.findOne({
      _id: req.params.id,
      user: req.userId
    });

    if (!reservation) {
      return res.status(404).send({
        message: "reservation khong ton tai"
      });
    }

    if (reservation.status !== "actived") {
      return res.status(400).send({
        message: "reservation khong the huy"
      });
    }

    for (const item of reservation.items) {
      let inventory = await inventoryModel.findOne({
        product: item.product
      });

      if (inventory) {
        inventory.reserved = Math.max(0, inventory.reserved - item.quantity);
        await inventory.save();
      }
    }

    reservation.status = "cancelled";
    await reservation.save();
    await reservation.populate("items.product");
    await reservation.populate("user");

    res.send(reservation);
  } catch (error) {
    res.status(400).send({
      message: error.message
    });
  }
});

module.exports = router;
